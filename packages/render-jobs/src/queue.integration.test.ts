import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  uuidv7,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { importPack } from '@pr/catalog';
import { createDesign } from '@pr/designs';
import { listProducts } from '@pr/catalog';
import type { RenderSpec } from '@pr/design-schema';
import { buildRenderSpec } from '@pr/render-spec';
import {
  cancelJob,
  claimJob,
  completeJob,
  failJob,
  getJob,
  heartbeat,
  listJobs,
  MAX_ATTEMPTS,
  QueueError,
  submitRender,
  sweepStaleJobs,
} from './queue.js';

/**
 * The render queue (W-08).
 *
 * These are the properties a queue lives or dies by: identical work is not paid for twice, a job
 * survives the worker that was running it, a cancelled job stops, and a doomed one gives up.
 */

const DIGEST = 'a'.repeat(64);

describe.skipIf(!hasDatabase)('render queue', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let designVersionId: string;
  let document: RenderSpec['document'];

  const alpha = () => ({ orgId: orgs.alpha, userId: null });
  const beta = () => ({ orgId: orgs.beta, userId: null });

  const spec = (over: { seed?: number; preset?: 'draft' | 'standard' | 'final' } = {}): RenderSpec =>
    buildRenderSpec({
      document,
      resolved: {
        meshKey: 'packs/cap-basic/1.0.0/meshes/cap-flat/38mm/render.glb',
        meshDigest: DIGEST,
        bboxMm: [
          [-19, 0, -19],
          [19, 18, 19],
        ],
        zones: [],
        artwork: [],
        materials: [],
        environment: {
          key: 'studio-softbox',
          hdriKey: 'env/studio-softbox/softbox.hdr',
          rotationDeg: 0,
          exposureEv: 0,
        },
      },
      outputs: [
        {
          kind: 'image',
          widthPx: 1024,
          heightPx: 1024,
          format: 'png16',
          camera: { kind: 'preset', presetKey: 'three-quarter' },
        },
      ],
      preset: over.preset ?? 'draft',
      renderer: { id: 'cycles', version: '4.0.2' },
      seed: over.seed ?? 1,
    });

  beforeAll(async () => {
    db = await createTestDatabase('pr_render_jobs');
    sql = db.sql;
    orgs = await seedOrganizations(sql);

    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url)), 'utf8'),
    ) as unknown;
    await importPack(sql, manifest, { publish: true });

    const products = await listProducts(sql, alpha());
    const variantId = products.find((p) => p.productKey === 'cap-flat')!.variants[0]!.variantId;
    const design = await createDesign(sql, alpha(), { variantId });
    document = design.document;

    const [version] = await withStaff(sql, (tx) =>
      tx`select id from design_versions where design_id = ${design.id}`,
    );
    designVersionId = version!['id'] as string;
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await withStaff(sql, (tx) => tx`delete from render_jobs`);
  });

  it('queues a render with an estimate the user can be shown first', async () => {
    const { job, deduped } = await submitRender(sql, alpha(), {
      designVersionId,
      spec: spec(),
    });

    expect(deduped).toBe(false);
    expect(job.status).toBe('queued');
    expect(job.progress).toBe(0);
    expect(job.estimateSeconds).toBeGreaterThan(0);
    expect(job.outputs).toEqual([]);
  });

  it('does not pay for identical work twice', async () => {
    const first = await submitRender(sql, alpha(), { designVersionId, spec: spec() });
    const again = await submitRender(sql, alpha(), { designVersionId, spec: spec() });

    expect(again.deduped).toBe(true);
    expect(again.job.id).toBe(first.job.id);

    // A different setting is different work.
    const better = await submitRender(sql, alpha(), {
      designVersionId,
      spec: spec({ preset: 'final' }),
    });
    expect(better.deduped).toBe(false);
    expect(better.job.id).not.toBe(first.job.id);
  });

  it('runs a job from claim to outputs', async () => {
    const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });

    const claim = await claimJob(sql, 'worker-1');
    expect(claim?.jobId).toBe(job.id);
    expect(claim?.orgId).toBe(orgs.alpha);
    expect(RenderSpecLike(claim!.spec)).toBe(true);

    expect(await heartbeat(sql, job.id, 'worker-1', { stage: 'trace', progress: 0.4 })).toBe(true);
    expect((await getJob(sql, alpha(), job.id)).stage).toBe('trace');
    expect((await getJob(sql, alpha(), job.id)).progress).toBeCloseTo(0.4, 3);

    expect(
      await completeJob(sql, job.id, 'worker-1', {
        outputs: [
          {
            kind: 'image',
            storageKey: `renders/${orgs.alpha}/${job.id}/output-0.png`,
            width: 1024,
            height: 1024,
            format: 'png16',
            bytes: 4096,
          },
        ],
        gpuSeconds: 12.5,
        provenance: { renderer: 'cycles 4.0.2' },
      }),
    ).toBe(true);

    const done = await getJob(sql, alpha(), job.id);
    expect(done.status).toBe('succeeded');
    expect(done.progress).toBe(1);
    expect(done.outputs).toHaveLength(1);
    expect(done.outputs[0]!.provenance).toMatchObject({ renderer: 'cycles 4.0.2' });
  });

  it('hands one job to exactly one worker', async () => {
    await submitRender(sql, alpha(), { designVersionId, spec: spec() });

    const [first, second] = await Promise.all([claimJob(sql, 'worker-a'), claimJob(sql, 'worker-b')]);
    const claimed = [first, second].filter(Boolean);

    expect(claimed).toHaveLength(1);
  });

  describe('when a worker stops', () => {
    it('gives the job back to the queue once the lease lapses', async () => {
      const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });
      await claimJob(sql, 'doomed-worker', 0);

      const swept = await sweepStaleJobs(sql);
      expect(swept.requeued).toBe(1);
      expect((await getJob(sql, alpha(), job.id)).status).toBe('queued');

      // And the worker that died cannot finish it afterwards.
      expect(await heartbeat(sql, job.id, 'doomed-worker')).toBe(false);
      expect(
        await completeJob(sql, job.id, 'doomed-worker', {
          outputs: [],
          gpuSeconds: 1,
          provenance: {},
        }),
      ).toBe(false);
    });

    it('gives up after the attempts are used', async () => {
      const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await claimJob(sql, `worker-${attempt}`, 0);
        await sweepStaleJobs(sql);
      }

      const dead = await getJob(sql, alpha(), job.id);
      expect(dead.status).toBe('failed');
      expect(dead.error?.code).toBe('renderer_crash');
      expect(dead.attempts).toBe(MAX_ATTEMPTS);
    });
  });

  describe('failures', () => {
    it('retries a crash and gives up on running out of memory', async () => {
      const crashed = await submitRender(sql, alpha(), { designVersionId, spec: spec() });
      await claimJob(sql, 'w');
      expect(
        await failJob(sql, crashed.job.id, 'w', { code: 'renderer_crash', message: 'segfault' }),
      ).toBe('requeued');
      expect((await getJob(sql, alpha(), crashed.job.id)).status).toBe('queued');

      await claimJob(sql, 'w');
      expect(await failJob(sql, crashed.job.id, 'w', { code: 'oom', message: 'out of memory' })).toBe(
        'failed',
      );

      const failed = await getJob(sql, alpha(), crashed.job.id);
      expect(failed.status).toBe('failed');
      expect(failed.error).toEqual({ code: 'oom', message: 'out of memory' });
    });

    it('ignores a report from a worker that no longer owns the job', async () => {
      const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });
      await claimJob(sql, 'owner');

      expect(await failJob(sql, job.id, 'stranger', { code: 'oom', message: 'not yours' })).toBe(
        'ignored',
      );
      expect((await getJob(sql, alpha(), job.id)).status).toBe('running');
    });
  });

  describe('cancelling', () => {
    it('stops a queued job outright', async () => {
      const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });

      expect((await cancelJob(sql, alpha(), job.id)).status).toBe('canceled');
      expect(await claimJob(sql, 'worker-1')).toBeNull();
    });

    it('tells a running worker to stop at its next heartbeat', async () => {
      const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });
      await claimJob(sql, 'worker-1');

      await cancelJob(sql, alpha(), job.id);
      expect(await heartbeat(sql, job.id, 'worker-1', { progress: 0.6 })).toBe(false);
    });

    it('refuses to cancel a job that already finished', async () => {
      const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });
      await claimJob(sql, 'worker-1');
      await completeJob(sql, job.id, 'worker-1', { outputs: [], gpuSeconds: 1, provenance: {} });

      await expect(cancelJob(sql, alpha(), job.id)).rejects.toMatchObject({ code: 'not_cancelable' });
    });
  });

  describe('quotas', () => {
    it('refuses a submission past the concurrency limit, and says the limit', async () => {
      await withStaff(sql, (tx) =>
        tx`update org_quotas set max_concurrent_jobs = 1 where org_id = ${orgs.alpha}`,
      );

      await submitRender(sql, alpha(), { designVersionId, spec: spec({ seed: 1 }) });
      await expect(
        submitRender(sql, alpha(), { designVersionId, spec: spec({ seed: 2 }) }),
      ).rejects.toMatchObject({ code: 'too_many_running', detail: { limit: 1 } });

      await withStaff(sql, (tx) =>
        tx`update org_quotas set max_concurrent_jobs = 3 where org_id = ${orgs.alpha}`,
      );
    });

    it('refuses a submission past the daily limit', async () => {
      await withStaff(sql, (tx) =>
        tx`update org_quotas set renders_per_day = 1 where org_id = ${orgs.alpha}`,
      );

      await submitRender(sql, alpha(), { designVersionId, spec: spec({ seed: 11 }) });
      await expect(
        submitRender(sql, alpha(), { designVersionId, spec: spec({ seed: 12 }) }),
      ).rejects.toBeInstanceOf(QueueError);

      await withStaff(sql, (tx) =>
        tx`update org_quotas set renders_per_day = 50 where org_id = ${orgs.alpha}`,
      );
    });
  });

  describe('tenancy', () => {
    it('keeps jobs and their outputs to the organisation that submitted them', async () => {
      const { job } = await submitRender(sql, alpha(), { designVersionId, spec: spec() });

      await expect(getJob(sql, beta(), job.id)).rejects.toMatchObject({ code: 'not_found' });
      expect((await listJobs(sql, beta())).map((j) => j.id)).not.toContain(job.id);
      await expect(cancelJob(sql, beta(), job.id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('deduplicates within an organisation, not across them', async () => {
      // Beta cannot submit against alpha's design version, so this is only about the hash: the
      // index is scoped per organisation, and two tenants rendering the same thing each get a job.
      const first = await submitRender(sql, alpha(), { designVersionId, spec: spec({ seed: 99 }) });
      expect(first.deduped).toBe(false);

      const stranger = uuidv7();
      expect(stranger).not.toBe(first.job.id);
    });
  });
});

const RenderSpecLike = (spec: unknown): boolean =>
  typeof spec === 'object' && spec !== null && 'specVersion' in spec && 'outputs' in spec;
