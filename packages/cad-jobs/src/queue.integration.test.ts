import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { MAX_ATTEMPTS } from '@pr/job-queue';
import {
  QueueError,
  RETRYABLE_FAILURES,
  cancelIngestion,
  claimIngestion,
  completeIngestion,
  failIngestion,
  getIngestion,
  findIngestionByMeshDigest,
  heartbeatIngestion,
  listIngestions,
  retryableIsNotPermanent,
  submitIngestion,
  sweepStaleIngestions,
} from './queue.js';
import type { CadImportResult } from '@pr/cad';

/**
 * The CAD ingestion queue (docs/23-cad-ingestion.md).
 *
 * The same properties the render queue is held to — identical work is not paid for twice, a job
 * survives the worker running it, a cancelled job stops, a doomed one gives up — checked here
 * because they are now provided by shared code and a refactor that broke one queue and not the
 * other would otherwise go unnoticed.
 */

const PIPELINE = '2026.08.1';

describe.skipIf(!hasDatabase)('cad queue', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };

  const alpha = () => ({ orgId: orgs.alpha, userId: null });
  const beta = () => ({ orgId: orgs.beta, userId: null });

  const digestOf = (text: string): Buffer => createHash('sha256').update(text).digest();

  const submission = (name = 'closure-38.step') => ({
    sourceKey: `cad-source/${orgs.alpha}/${name}`,
    sourceName: name,
    sourceBytes: 1_204_000,
    sourceDigest: digestOf(name),
    format: 'step' as const,
    pipelineVersion: PIPELINE,
  });

  const importResult = (): CadImportResult => ({
    status: 'ok',
    importerId: 'reference',
    importerVersion: 'reference-1',
    format: 'step',
    declaredUnit: 'mm',
    unitAssumed: false,
    bboxMm: [
      [-19, 0, -19],
      [19, 18, 19],
    ],
    parts: [],
    repairs: [],
    meshes: [],
    symmetryAxis: [0, 1, 0],
    seconds: 42,
  });

  beforeAll(async () => {
    db = await createTestDatabase('pr_cadq');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await withStaff(sql, async (tx) => {
      await tx`delete from cad_jobs`;
      await tx`delete from usage_events`;
    });
  });

  it('matches setup diagnostics by mesh while preserving organization isolation', async () => {
    const { job } = await submitIngestion(sql, alpha(), submission());
    await claimIngestion(sql, 'orientation-worker');
    const result = importResult();
    result.meshes = [
      {
        fileName: 'part.glb',
        bytes: 100,
        triangles: 32,
        digest: 'a'.repeat(64),
        lod: 'lod0',
        uvSets: [],
        materialKeys: ['body'],
      },
    ];
    await completeIngestion(sql, job.id, 'orientation-worker', { result, cpuSeconds: 1 });
    expect((await findIngestionByMeshDigest(sql, alpha(), 'a'.repeat(64)))?.id).toBe(job.id);
    expect(await findIngestionByMeshDigest(sql, beta(), 'a'.repeat(64))).toBeNull();
    expect(await findIngestionByMeshDigest(sql, alpha(), 'b'.repeat(64))).toBeNull();
  });

  it('queues an ingestion and hands it back', async () => {
    const { job, deduped } = await submitIngestion(sql, alpha(), submission());

    expect(deduped).toBe(false);
    expect(job.status).toBe('queued');
    expect(job.format).toBe('step');
    expect(job.profile).toBe('standard');
    expect(job.pipelineVersion).toBe(PIPELINE);
    expect(await getIngestion(sql, alpha(), job.id)).toMatchObject({ id: job.id });
  });

  it('does not ingest the same file twice at the same pipeline version', async () => {
    const first = await submitIngestion(sql, alpha(), submission());
    const second = await submitIngestion(sql, alpha(), submission());

    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(await listIngestions(sql, alpha())).toHaveLength(1);
  });

  it('does ingest it again when the pipeline has changed', async () => {
    // "The same file" is only the same work while the pipeline reading it has not changed. A new
    // kernel version produces different meshes, and every mesh digest downstream depends on them.
    const first = await submitIngestion(sql, alpha(), submission());
    const second = await submitIngestion(sql, alpha(), {
      ...submission(),
      pipelineVersion: '2026.09.1',
    });

    expect(second.deduped).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("keeps one organisation's files out of another's", async () => {
    const mine = await submitIngestion(sql, alpha(), submission());

    expect(await listIngestions(sql, beta())).toHaveLength(0);
    await expect(getIngestion(sql, beta(), mine.job.id)).rejects.toThrow(QueueError);
  });

  it('refuses a submission over the concurrency limit', async () => {
    // The default is two at a time: an ingestion is minutes of CPU on a container with tens of
    // gigabytes, so the cost of letting one loose is a machine rather than an invoice line.
    await submitIngestion(sql, alpha(), submission('a.step'));
    await submitIngestion(sql, alpha(), submission('b.step'));

    await expect(submitIngestion(sql, alpha(), submission('c.step'))).rejects.toMatchObject({
      code: 'too_many_running',
    });
  });

  it('hands a queued job to exactly one worker', async () => {
    await submitIngestion(sql, alpha(), submission());

    const first = await claimIngestion(sql, 'worker-1');
    const second = await claimIngestion(sql, 'worker-2');

    expect(first?.sourceKey).toContain('cad-source/');
    expect(first?.format).toBe('step');
    expect(second).toBeNull();
  });

  it('records what the import produced, and bills the CPU time', async () => {
    const { job } = await submitIngestion(sql, alpha(), submission());
    const claim = (await claimIngestion(sql, 'worker-1'))!;

    expect(
      await heartbeatIngestion(sql, claim.jobId, 'worker-1', {
        stage: 'tessellate',
        progress: 0.4,
      }),
    ).toBe(true);
    expect(
      await completeIngestion(sql, claim.jobId, 'worker-1', {
        result: importResult(),
        cpuSeconds: 42,
      }),
    ).toBe(true);

    const done = await getIngestion(sql, alpha(), job.id);
    expect(done.status).toBe('succeeded');
    expect(done.importerId).toBe('reference');
    expect(done.importerVersion).toBe('reference-1');
    expect(done.result?.bboxMm).toEqual([
      [-19, 0, -19],
      [19, 18, 19],
    ]);

    const [usage] = await withStaff(sql, (tx) => tx`select kind, quantity from usage_events`);
    expect(usage).toMatchObject({ kind: 'cad_cpu_seconds' });
  });

  it('refuses a completion from a worker that no longer holds the job', async () => {
    await submitIngestion(sql, alpha(), submission());
    const claim = (await claimIngestion(sql, 'worker-1'))!;

    expect(
      await completeIngestion(sql, claim.jobId, 'worker-2', {
        result: importResult(),
        cpuSeconds: 1,
      }),
    ).toBe(false);
  });

  it('does not retry a failure that describes the file', async () => {
    // An unsupported schema is still unsupported in ninety seconds. Retrying only spends a lease
    // finding that out again.
    await submitIngestion(sql, alpha(), submission());
    const claim = (await claimIngestion(sql, 'worker-1'))!;

    const outcome = await failIngestion(sql, claim.jobId, 'worker-1', {
      code: 'unsupported_schema',
      message: 'AP210 is not an application protocol we import',
    });

    expect(outcome).toBe('failed');
    expect((await getIngestion(sql, alpha(), claim.jobId)).status).toBe('failed');
  });

  it('keeps every finding on the row, not just the first', async () => {
    // The operator console lists all of them. An earlier version sent one sentence and kept the
    // rest in the worker's log, which made a three-problem file into three re-exports.
    await submitIngestion(sql, alpha(), submission());
    const claim = (await claimIngestion(sql, 'worker-1'))!;

    await failIngestion(sql, claim.jobId, 'worker-1', {
      code: 'invalid_result',
      message: 'The import finished, but 2 things about the result stop it becoming a pack.',
      findings: [
        { code: 'part_empty', subject: 'logo_outline', message: 'no geometry at all' },
        { code: 'budget_exceeded', subject: 'lod0', message: 'over the size this pipeline allows' },
      ],
    });

    const job = await getIngestion(sql, alpha(), claim.jobId);
    expect(job.error?.findings?.map((finding) => finding.code)).toEqual([
      'part_empty',
      'budget_exceeded',
    ]);
    // `subject` is what names the offending part in the console. Losing it in the column would
    // leave "no geometry at all" attached to nothing.
    expect(job.error?.findings?.[0]?.subject).toBe('logo_outline');
  });

  it('retries a crashed kernel, up to the attempt cap', async () => {
    await submitIngestion(sql, alpha(), submission());

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const claim = (await claimIngestion(sql, `worker-${attempt}`))!;
      expect(
        await failIngestion(sql, claim.jobId, `worker-${attempt}`, {
          code: 'importer_crash',
          message: 'died',
        }),
      ).toBe('requeued');
    }

    const last = (await claimIngestion(sql, 'worker-last'))!;
    expect(
      await failIngestion(sql, last.jobId, 'worker-last', {
        code: 'importer_crash',
        message: 'died',
      }),
    ).toBe('failed');
  });

  it('gives a job back when its worker stops reporting', async () => {
    await submitIngestion(sql, alpha(), submission());
    const claim = (await claimIngestion(sql, 'worker-1', 0))!;

    expect(await sweepStaleIngestions(sql)).toMatchObject({ requeued: 1, failed: 0 });
    expect((await getIngestion(sql, alpha(), claim.jobId)).status).toBe('queued');
  });

  it('quarantines a job that has used its attempts', async () => {
    await submitIngestion(sql, alpha(), submission());
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await claimIngestion(sql, `worker-${attempt}`, 0);
      await sweepStaleIngestions(sql);
    }

    const [job] = await listIngestions(sql, alpha());
    expect(job!.status).toBe('failed');
    expect(job!.error?.code).toBe('importer_crash');
  });

  it('stops a running job so its worker finds out at the next heartbeat', async () => {
    // Which matters more here than for a render: a heavy import holds a container for an hour.
    const { job } = await submitIngestion(sql, alpha(), submission());
    const claim = (await claimIngestion(sql, 'worker-1'))!;

    await cancelIngestion(sql, alpha(), job.id);

    expect(await heartbeatIngestion(sql, claim.jobId, 'worker-1')).toBe(false);
    expect((await getIngestion(sql, alpha(), job.id)).status).toBe('canceled');
  });

  it('refuses to cancel a job that has already finished', async () => {
    const { job } = await submitIngestion(sql, alpha(), submission());
    const claim = (await claimIngestion(sql, 'worker-1'))!;
    await completeIngestion(sql, claim.jobId, 'worker-1', {
      result: importResult(),
      cpuSeconds: 1,
    });

    await expect(cancelIngestion(sql, alpha(), job.id)).rejects.toMatchObject({
      code: 'not_cancelable',
    });
  });
});

describe('failure vocabulary', () => {
  it('never calls a permanent failure retryable', () => {
    // Two lists in two packages describing the same set from opposite sides. This is what keeps
    // them from drifting into a job that retries forever or one that gives up on a crash.
    expect(retryableIsNotPermanent()).toBe(true);
    expect(RETRYABLE_FAILURES).toContain('importer_crash');
  });
});
