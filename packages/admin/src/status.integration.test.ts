import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  serviceEventRecorder,
  sqlServiceEventStore,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { appendJobLog, jobLogWriter, registerWorker, stopWorker, touchWorker } from '@pr/job-queue';
import { jobLog, listWorkers, systemStatus } from './status.js';

/**
 * The System Status page's one read, against a real database (F-ADM-15, F-ADM-07).
 *
 * Staged the way the audit found it: a worker killed mid-render whose job still says "running",
 * next to a healthy worker, a queue, a failure, and the server errors the page exists to show.
 */

/** Just enough of a render spec for an estimate. */
const SPEC = {
  quality: { samples: 128, displacement: { mode: 'none' } },
  document: { placements: [] },
  outputs: [{ kind: 'image', widthPx: 512, heightPx: 512 }],
};

describe.skipIf(!hasDatabase)('system status', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let versionId: string;
  const author = crypto.randomUUID();

  const job = async (over: Record<string, unknown>): Promise<string> => {
    const id = crypto.randomUUID();
    await withStaff(sql, (tx) => tx`
      insert into render_jobs ${tx({
        id,
        org_id: orgs.alpha,
        design_version_id: versionId,
        submitted_by: author,
        spec: tx.json(SPEC as never),
        spec_hash: Buffer.from(id),
        ...over,
      } as never)}`);
    return id;
  };

  beforeAll(async () => {
    db = await createTestDatabase('pr_status');
    sql = db.sql;
    orgs = await seedOrganizations(sql);

    versionId = crypto.randomUUID();
    await withStaff(sql, async (tx) => {
      const packId = crypto.randomUUID();
      const productId = crypto.randomUUID();
      const variantId = crypto.randomUUID();
      const designId = crypto.randomUUID();
      await tx`
        insert into users (id, org_id, email, role, status)
        values (${author}, ${orgs.alpha}, 'renders@alpha.test', 'member', 'active')`;
      await tx`
        insert into product_packs (id, key, version, name, status, manifest, digest)
        values (${packId}, 'status-pack', '1.0.0', 'Status pack', 'published', '{}'::jsonb, ${Buffer.alloc(32)})`;
      await tx`
        insert into products (id, pack_id, key, name, category, facets, sort, status)
        values (${productId}, ${packId}, 'thing', 'Thing', 'things', '{}'::jsonb, 0, 'published')`;
      await tx`
        insert into product_variants (id, product_id, key, name, dimensions_mm, material_slots, camera_presets, capabilities)
        values (${variantId}, ${productId}, 'one', 'One', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`;
      await tx`
        insert into designs (id, org_id, name, product_variant_id, created_by)
        values (${designId}, ${orgs.alpha}, 'Spring label', ${variantId}, ${author})`;
      await tx`
        insert into design_versions (id, design_id, org_id, version, schema_version, document, created_by)
        values (${versionId}, ${designId}, ${orgs.alpha}, 1, 1, '{}'::jsonb, ${author})`;
      await tx`update org_quotas set renders_per_day = 4 where org_id = ${orgs.alpha}`;
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('tells a dead worker from a live one, and flags the job the dead one holds', async () => {
    await registerWorker(sql, { id: 'render-live', kind: 'render', host: 'a', pid: 1, engine: 'cycles-local', engineVersion: '4.2' });
    await registerWorker(sql, { id: 'render-dead', kind: 'render', host: 'b', pid: 2, engine: 'cycles-local' });
    await registerWorker(sql, { id: 'cad-stopped', kind: 'cad', host: 'c', pid: 3 });
    await stopWorker(sql, 'cad-stopped');

    const healthy = await job({ status: 'running', worker_id: 'render-live', stage: 'trace', progress: 0.4, started_at: new Date(), lease_expires_at: new Date(Date.now() + 60_000) });
    await touchWorker(sql, 'render-live', healthy);
    // Killed mid-render: its last heartbeat was a minute ago, and its lease has not lapsed yet.
    const orphan = await job({ status: 'running', worker_id: 'render-dead', stage: 'trace', progress: 0.2, started_at: new Date(), lease_expires_at: new Date(Date.now() + 60_000) });
    await withStaff(sql, (tx) => tx`update workers set last_seen_at = now() - interval '60 seconds' where id = 'render-dead'`);

    const status = await systemStatus(sql);

    const byId = new Map(status.workers.map((w) => [w.id, w]));
    expect(byId.get('render-live')).toMatchObject({ liveness: 'alive', currentJobId: healthy, engineVersion: '4.2' });
    expect(byId.get('render-dead')?.liveness).toBe('stale');
    expect(byId.get('cad-stopped')?.liveness).toBe('stopped');

    const running = new Map(status.render.running.map((j) => [j.id, j]));
    expect(running.get(healthy)).toMatchObject({
      concerns: [],
      progress: 0.4,
      stage: 'trace',
      orgName: 'Alpha Organisation',
      submittedBy: 'renders@alpha.test',
      designName: 'Spring label',
    });
    expect(running.get(orphan)?.concerns).toEqual(['worker_silent']);
    expect(await listWorkers(sql)).toHaveLength(3);
  });

  it('lines the queue up in the order it will be claimed', async () => {
    const second = await job({ status: 'queued', queued_at: new Date(Date.now() - 5_000) });
    const first = await job({ status: 'queued', queued_at: new Date(Date.now() - 50_000) });

    const status = await systemStatus(sql);
    expect(status.render.queued.map((j) => [j.id, j.position])).toEqual([
      [first, 1],
      [second, 2],
    ]);
    expect(status.render.counts.queued).toBe(2);
    expect(status.render.oldestQueuedSec).toBeGreaterThanOrEqual(49);
    // A live render worker exists, so nothing is waiting on a worker that is not there.
    expect(status.render.queued.every((j) => j.concerns.length === 0)).toBe(true);
  });

  it('sums the last day, and names the organisation about to hit its limit', async () => {
    const finished = new Date();
    const started = new Date(finished.getTime() - 40_000);
    await job({ status: 'succeeded', started_at: started, finished_at: finished, gpu_seconds: 40 });
    await job({ status: 'failed', started_at: started, finished_at: finished, error: sql.json({ code: 'oom', message: 'x' } as never) });

    const status = await systemStatus(sql);
    expect(status.last24h).toMatchObject({ succeeded: 1, failed: 1, medianSec: 40, gpuSeconds: 40 });
    expect(status.last24h.failuresByCode).toEqual([{ code: 'oom', count: 1 }]);
    expect(status.last24h.hourly).toHaveLength(24);
    expect(status.last24h.hourly.at(-1)).toMatchObject({ succeeded: 1, failed: 1 });
    // Six renders today against a limit of four: Alpha is at its limit; Beta has done nothing.
    expect(status.nearLimit.map((o) => o.orgName)).toEqual(['Alpha Organisation']);
  });

  it('records server errors and shows them newest first, filtered on request', async () => {
    const recorder = serviceEventRecorder('web', sqlServiceEventStore(sql), { flushMs: 60_000 });
    recorder.report(new Error('connection reset'), { message: 'request failed', requestId: 'req-1', route: 'renders', status: 500 }, 'error');
    recorder.report(undefined, { message: 'could not send a message', template: 'invite' }, 'warn');
    await recorder.stop();
    const worker = serviceEventRecorder('worker-render', sqlServiceEventStore(sql), { flushMs: 60_000 });
    worker.report(undefined, { message: 'swept stale jobs', requeued: 1 }, 'warn');
    await worker.stop();

    const all = await systemStatus(sql);
    expect(all.events.recent.map((e) => e.message)).toEqual(['swept stale jobs', 'could not send a message', 'request failed']);
    expect(all.events.recent[2]).toMatchObject({
      service: 'web',
      level: 'error',
      requestId: 'req-1',
      fields: { route: 'renders', status: 500 },
      error: { name: 'Error', message: 'connection reset' },
    });
    expect(all.events).toMatchObject({ errorsLastHour: 1, warningsLastHour: 2, mailFailures24h: 1, services: ['web', 'worker-render'] });

    const errors = await systemStatus(sql, { events: { level: 'error' } });
    expect(errors.events.recent.map((e) => e.message)).toEqual(['request failed']);
    const fromWorker = await systemStatus(sql, { events: { service: 'worker-render' } });
    expect(fromWorker.events.recent.map((e) => e.message)).toEqual(['swept stale jobs']);
  });

  it('forgets events older than two weeks', async () => {
    await withStaff(sql, (tx) => tx`
      insert into service_events (at, service, level, message) values (now() - interval '15 days', 'web', 'error', 'ancient')`);
    await sqlServiceEventStore(sql).prune();
    const [row] = await withStaff(sql, (tx) => tx`select count(*)::int as n from service_events where message = 'ancient'`);
    expect(row!['n']).toBe(0);
  });

  it("keeps a job's own log, oldest first, and only the newest lines", async () => {
    const id = await job({ status: 'running', worker_id: 'render-live' });
    const line = (message: string) => ({ at: new Date().toISOString(), level: 'info' as const, message });

    await appendJobLog(sql, 'render_jobs', id, [line('one'), line('two')], 3);
    await appendJobLog(sql, 'render_jobs', id, [line('three'), line('four')], 3);
    expect((await jobLog(sql, 'render', id)).map((l) => l.message)).toEqual(['two', 'three', 'four']);

    const writer = jobLogWriter(sql, 'render_jobs', id, 60);
    writer.record({ time: new Date().toISOString(), level: 'debug', message: 'progress', fields: { fraction: 0.5 } });
    writer.record({ time: new Date().toISOString(), level: 'error', message: 'renderer failed', fields: { jobId: id, code: 'oom' } });
    await writer.close();
    const log = await jobLog(sql, 'render', id);
    expect(log.at(-1)).toMatchObject({ level: 'error', message: 'renderer failed', fields: { code: 'oom' } });
    expect(log.some((l) => l.message === 'progress')).toBe(false);
  });

  it('is staff-only: an organisation sees neither workers nor the server log', async () => {
    const seen = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${orgs.alpha}, true)`;
      const workers = await tx`select count(*)::int as n from workers`;
      const events = await tx`select count(*)::int as n from service_events`;
      return [workers[0]!['n'], events[0]!['n']];
    });
    expect(seen).toEqual([0, 0]);
  });
});
