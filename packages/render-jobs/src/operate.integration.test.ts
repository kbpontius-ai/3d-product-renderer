import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { importPack, listProducts } from '@pr/catalog';
import { createDesign } from '@pr/designs';
import type { RenderSpec } from '@pr/design-schema';
import { buildRenderSpec } from '@pr/render-spec';
import { claimJob, completeJob, deleteJob, failJob, getJob, QueueError, submitRender, MAX_ATTEMPTS } from './queue.js';
import {
  cancelJobForStaff,
  getJobForStaff,
  listAllJobs,
  queueSnapshot,
  retryFailed,
  retryJob,
} from './operate.js';

/**
 * Operating the queue (F-ADM-07).
 *
 * Staff see every organisation's work, which the tenant API deliberately cannot — so the thing to
 * prove is that the crossing happens here and nowhere else, and that a retry really does put a
 * spent job back in front of a worker.
 */

const DIGEST = 'a'.repeat(64);
const loadPack = (key: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url)), 'utf8'),
  );

describe.skipIf(!hasDatabase)('queue operations', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let designVersions: { alpha: string; beta: string };
  let document: RenderSpec['document'];

  const spec = (seed: number): RenderSpec =>
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
          widthPx: 512,
          heightPx: 512,
          format: 'png16',
          camera: { kind: 'preset', presetKey: 'three-quarter' },
        },
      ],
      preset: 'draft',
      renderer: { id: 'cycles', version: '4.0.2' },
      seed,
    });

  beforeAll(async () => {
    db = await createTestDatabase('pr_operate');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
    await importPack(sql, loadPack('cap-basic'), { publish: true });

    const made = { alpha: '', beta: '' };
    for (const key of ['alpha', 'beta'] as const) {
      const ctx = { orgId: orgs[key], userId: null };
      const [product] = await listProducts(sql, ctx);
      const design = await createDesign(sql, ctx, { variantId: product!.variants[0]!.variantId });
      const [version] = await withStaff(sql, (tx) =>
        tx`select id from design_versions where design_id = ${design.id}`,
      );
      made[key] = version!['id'] as string;
      if (key === 'alpha') document = design.document;
    }
    designVersions = made;
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await withStaff(sql, (tx) => tx`delete from render_jobs`);
  });

  /** A job in whatever state the test needs. */
  async function jobIn(status: 'queued' | 'failed', org: 'alpha' | 'beta' = 'alpha'): Promise<string> {
    const { job } = await submitRender(
      sql,
      { orgId: orgs[org], userId: null },
      { designVersionId: designVersions[org], spec: spec(Math.floor(Math.random() * 1e9)) },
    );
    if (status === 'failed') {
      const claim = await claimJob(sql, 'worker-test');
      await failJob(sql, claim!.jobId, 'worker-test', { code: 'internal', message: 'exploded' });
      // One failure is a requeue; keep failing until it is genuinely spent.
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        const again = await claimJob(sql, 'worker-test');
        if (!again) break;
        await failJob(sql, again.jobId, 'worker-test', { code: 'internal', message: 'exploded' });
      }
    }
    return job.id;
  }

  it('shows every organisation, which no tenant view does', async () => {
    await jobIn('queued', 'alpha');
    await jobIn('queued', 'beta');

    const jobs = await listAllJobs(sql);
    expect(new Set(jobs.map((j) => j.orgId))).toEqual(new Set([orgs.alpha, orgs.beta]));
    expect(jobs[0]?.orgName).toBeTruthy();
  });

  it('counts what is where, and how long the oldest has waited', async () => {
    await jobIn('queued');
    await jobIn('failed');

    const snapshot = await queueSnapshot(sql);
    expect(snapshot.counts.queued).toBe(1);
    expect(snapshot.counts.failed).toBe(1);
    expect(snapshot.oldestQueuedSec).toBeGreaterThanOrEqual(0);
  });

  it('names the worker holding each running job', async () => {
    await jobIn('queued');
    await claimJob(sql, 'worker-visible');

    const snapshot = await queueSnapshot(sql);
    expect(snapshot.workers.map((w) => w.workerId)).toContain('worker-visible');
  });

  it('retries a job whose automatic attempts are spent', async () => {
    const id = await jobIn('failed');
    const before = await getJobForStaff(sql, id);
    expect(before.status).toBe('failed');
    expect(before.attempts).toBe(MAX_ATTEMPTS);

    const after = await retryJob(sql, id, null);
    expect(after.status).toBe('queued');
    // Attempts reset: a considered retry must not be refused because the automatic ones are gone.
    expect(after.attempts).toBe(0);
    expect(after.error).toBeNull();

    const claimed = await claimJob(sql, 'worker-after-retry');
    expect(claimed?.jobId).toBe(id);
  });

  it('refuses to retry something already on the queue', async () => {
    const id = await jobIn('queued');
    await expect(retryJob(sql, id, null)).rejects.toThrow(/already queued/);
  });

  it('refuses to retry a render that succeeded', async () => {
    // It would render the same pixels again and charge the organisation for them.
    await jobIn('queued');
    const claim = await claimJob(sql, 'worker-done');
    await completeJob(sql, claim!.jobId, 'worker-done', { outputs: [], gpuSeconds: 1, provenance: {} });

    await expect(retryJob(sql, claim!.jobId, null)).rejects.toMatchObject({ code: 'not_retryable' });
    expect((await getJobForStaff(sql, claim!.jobId)).status).toBe('succeeded');
  });

  it('cancels a running job so the worker lets go at its next heartbeat', async () => {
    await jobIn('queued');
    const claim = await claimJob(sql, 'worker-cancel');

    const canceled = await cancelJobForStaff(sql, claim!.jobId, null, 'stuck');
    expect(canceled.status).toBe('canceled');
    expect(canceled.error).toMatchObject({ code: 'canceled', message: 'stuck' });
  });

  it('replays a batch of failures after whatever broke them is fixed', async () => {
    await jobIn('failed');
    await jobIn('failed', 'beta');

    const requeued = await retryFailed(sql, { limit: 10 }, null);
    expect(requeued).toBe(2);
    expect((await queueSnapshot(sql)).counts.queued).toBe(2);
  });

  it('deletes a finished render, and frees the design to be rendered again', async () => {
    const id = await jobIn('failed');
    const ctx = { orgId: orgs.alpha, userId: null };

    await deleteJob(sql, ctx, id);
    await expect(getJob(sql, ctx, id)).rejects.toThrow(QueueError);
    expect((await queueSnapshot(sql)).counts.failed).toBe(0);
  });

  it('refuses to delete a job a worker is holding', async () => {
    await jobIn('queued');
    const claim = await claimJob(sql, 'worker-holding');

    await expect(deleteJob(sql, { orgId: orgs.alpha, userId: null }, claim!.jobId)).rejects.toThrow(
      /cancel it before/,
    );
  });

  it('is not another organisation’s render to delete', async () => {
    const id = await jobIn('failed', 'alpha');

    await expect(deleteJob(sql, { orgId: orgs.beta, userId: null }, id)).rejects.toThrow(QueueError);
  });

  it('records every intervention against the organisation it touched', async () => {
    const id = await jobIn('failed');
    await retryJob(sql, id, null);

    const entries = await withStaff(sql, (tx) =>
      tx`select action, org_id, target_id from audit_log where target_id = ${id}`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'render.retried', org_id: orgs.alpha });
  });
});
