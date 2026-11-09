import {
  lockArtworkUsage,
  assertActiveArtworkReferences,
  assertDesignArtworkActive,
} from '@pr/artworks';
import { uuidv7, withStaff, withTenant, type Sql, type TenantContext, type Tx } from '@pr/db';
import type { RenderSpec } from '@pr/design-schema';
import {
  DEFAULT_LEASE_SEC,
  MAX_ATTEMPTS,
  QueueError,
  assertWithinQuota as assertQuota,
  cancelPending,
  claimNext,
  heartbeatJob,
  heldBy,
  isUniqueViolation,
  markSucceeded,
  recordFailure,
  sweepStale,
  type JobStatus,
} from '@pr/job-queue';
import { estimateRender, specHash } from '@pr/render-spec';

/**
 * The render queue (W-08, build order H2/H6).
 *
 * Postgres is the queue. `for update skip locked` is what makes that safe with several workers, and
 * a lease is what makes it safe when one of them dies mid-job: nothing is lost, the work is simply
 * claimable again once the lease lapses.
 *
 * Two rules shape everything here. Identical work is never paid for twice — the spec hash is the
 * identity of a render, so resubmitting the same design at the same settings returns the job that
 * already exists. And a job that is not making progress is not left running forever: leases expire,
 * attempts are counted, and the third failure is final.
 *
 * The lease mechanics themselves live in `@pr/job-queue`, because the CAD queue needs the same ones
 * and a second copy of this code would be a second copy of the bugs it no longer has. What stays
 * here is what makes a render a render: the spec, its hash, the estimate, and the outputs.
 */

export { DEFAULT_LEASE_SEC, MAX_ATTEMPTS, QueueError, type JobStatus };

/** The table this queue lives in. Named once, because it is now an argument rather than literal. */
const TABLE = 'render_jobs';

export type FailureCode =
  | 'oom'
  | 'timeout'
  | 'asset_missing'
  | 'renderer_crash'
  | 'renderer_unavailable'
  | 'canceled'
  | 'internal';

export interface RenderOutput {
  kind: 'image' | 'video' | 'thumb' | 'contact_sheet';
  storageKey: string;
  width?: number;
  height?: number;
  format?: string;
  bytes?: number;
  /**
   * A web-sized copy of the same image (F-EXP-01), for showing rather than downloading.
   *
   * Optional because outputs written before there was one do not have it, and because a backend is
   * not obliged to make one. Anything displaying a render falls back to the original.
   */
  webStorageKey?: string;
  webBytes?: number;
  provenance?: Record<string, unknown>;
}

export interface RenderJob {
  id: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  designVersionId: string;
  estimateSeconds: number;
  estimateCents: number;
  error: { code: FailureCode; message: string } | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputs: RenderOutput[];
}

export interface SubmitResult {
  job: RenderJob;
  /** True when an identical render was already queued, running or finished. */
  deduped: boolean;
}

export async function submitRender(
  sql: Sql,
  ctx: TenantContext,
  input: { designVersionId: string; spec: RenderSpec; priority?: number; traceId?: string },
): Promise<SubmitResult> {
  const hash = Buffer.from(specHash(input.spec), 'hex');
  const estimate = estimateRender(input.spec);

  return withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    const [version] =
      await tx`select design_id, document from design_versions where id = ${input.designVersionId}`;
    if (!version) throw new QueueError('not_found');
    await assertDesignArtworkActive(tx, version['design_id'] as string);
    await assertActiveArtworkReferences(
      tx,
      version['document'] as import('@pr/design-schema').DesignDocument,
    );
    const existing = await findByHash(tx, hash);
    if (existing) return { job: existing, deduped: true };

    await assertWithinQuota(tx, ctx.orgId);

    const id = uuidv7();
    try {
      await tx`
        insert into render_jobs
          (id, org_id, design_version_id, submitted_by, spec, spec_hash, priority,
           renderer_id, renderer_version, cost_estimate_cents, trace_id)
        values
          (${id}, ${ctx.orgId}, ${input.designVersionId}, ${ctx.userId},
           ${sql.json(input.spec as never)}, ${hash}, ${input.priority ?? 100},
           ${input.spec.renderer.id}, ${input.spec.renderer.version}, ${Math.round(estimate.cents)},
           ${input.traceId ?? null})`;
    } catch (error) {
      // Two tabs pressing Render at the same moment: the loser reads the winner's job rather than
      // failing, which is the same answer it would have got a millisecond earlier.
      if (isUniqueViolation(error)) {
        const raced = await findByHash(tx, hash);
        if (raced) return { job: raced, deduped: true };
      }
      throw error;
    }

    const job = await findById(tx, id);
    return { job: job!, deduped: false };
  });
}

export async function listJobs(sql: Sql, ctx: TenantContext, limit = 25): Promise<RenderJob[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select * from render_jobs order by queued_at desc limit ${limit}`;
    const outputs = await outputsFor(
      tx,
      rows.map((r) => r['id'] as string),
    );
    return rows.map((row) => toJob(row, outputs.get(row['id'] as string) ?? []));
  });
}

export async function getJob(sql: Sql, ctx: TenantContext, jobId: string): Promise<RenderJob> {
  return withTenant(sql, ctx, async (tx) => {
    const job = await findById(tx, jobId);
    if (!job) throw new QueueError('not_found');
    return job;
  });
}

/**
 * Cancels a job.
 *
 * A queued job stops existing as work; a running one is marked canceled and its worker finds out at
 * its next heartbeat, which is the only place it is safe to abandon a job from.
 */
export async function cancelJob(sql: Sql, ctx: TenantContext, jobId: string): Promise<RenderJob> {
  return withTenant(sql, ctx, async (tx) => {
    if (!(await cancelPending(tx, TABLE, jobId, ctx.userId))) {
      const job = await findById(tx, jobId);
      if (!job) throw new QueueError('not_found');
      throw new QueueError('not_cancelable', `job is ${job.status}`);
    }
    return (await findById(tx, jobId))!;
  });
}

/**
 * Removes a finished render (F-REND-07).
 *
 * Only a finished one: a live job is cancelled instead, because deleting the row a worker is
 * holding would leave it rendering into storage nobody will ever look at.
 *
 * The outputs go with it, which also frees the design to be rendered again at the same settings —
 * dedupe is by spec hash, and deleting is how someone says "that one was wrong, do it again". The
 * stored files are left to the retention job; storage is cheap and a half-deleted gallery is not.
 */
export async function deleteJob(sql: Sql, ctx: TenantContext, jobId: string): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    const [job] = await tx`select status from render_jobs where id = ${jobId}`;
    if (!job) throw new QueueError('not_found');
    if (job['status'] === 'queued' || job['status'] === 'running') {
      throw new QueueError('not_cancelable', 'cancel it before deleting it');
    }

    await tx`delete from render_outputs where job_id = ${jobId}`;
    await tx`delete from render_jobs where id = ${jobId}`;
  });
}

// --- worker side -------------------------------------------------------------------------------
// These run without a tenant: a worker serves every organisation, and the job row carries the one
// it belongs to.

export interface JobClaim {
  jobId: string;
  orgId: string;
  spec: unknown;
  attempts: number;
  /** The request that submitted it, when one was recorded; the worker logs under the same id. */
  traceId: string | null;
  /** Who asked for it, and what they were working on — so the worker can tell them it is done. */
  submittedBy: string | null;
  designId: string | null;
}

export async function claimJob(
  sql: Sql,
  workerId: string,
  leaseSec = DEFAULT_LEASE_SEC,
): Promise<JobClaim | null> {
  return withStaff(sql, async (tx) => {
    const row = await claimNext(tx, TABLE, workerId, leaseSec);
    if (!row) return null;

    const [design] = await tx`
      select design_id from design_versions where id = ${row['design_version_id']}`;

    return {
      jobId: row['id'] as string,
      orgId: row['org_id'] as string,
      spec: row['spec'],
      attempts: row['attempts'] as number,
      traceId: (row['trace_id'] as string | null) ?? null,
      submittedBy: (row['submitted_by'] as string | null) ?? null,
      designId: (design?.['design_id'] as string | null) ?? null,
    };
  });
}

/**
 * Extends the lease and reports where the job has got to.
 *
 * Returns false when the job is no longer this worker's to run — cancelled, or swept and reclaimed
 * by someone else. A worker that sees false stops immediately: continuing would mean two workers
 * writing the same outputs.
 */
export async function heartbeat(
  sql: Sql,
  jobId: string,
  workerId: string,
  update: { stage?: string; progress?: number } = {},
  leaseSec = DEFAULT_LEASE_SEC,
): Promise<boolean> {
  return withStaff(sql, (tx) => heartbeatJob(tx, TABLE, jobId, workerId, update, leaseSec));
}

export async function completeJob(
  sql: Sql,
  jobId: string,
  workerId: string,
  result: { outputs: RenderOutput[]; gpuSeconds: number; provenance: Record<string, unknown> },
): Promise<boolean> {
  return withStaff(sql, async (tx) => {
    const job = await heldBy(tx, TABLE, jobId, workerId);
    if (!job) return false;

    const orgId = job['org_id'] as string;
    for (const output of result.outputs) {
      await tx`
        insert into render_outputs
          (id, job_id, org_id, kind, storage_key, width, height, format, bytes,
           web_storage_key, web_bytes, provenance)
        values
          (${uuidv7()}, ${jobId}, ${orgId}, ${output.kind}, ${output.storageKey},
           ${output.width ?? null}, ${output.height ?? null}, ${output.format ?? null},
           ${output.bytes ?? null}, ${output.webStorageKey ?? null}, ${output.webBytes ?? null},
           ${sql.json({ ...result.provenance, ...output.provenance } as never)})`;
    }

    await markSucceeded(tx, TABLE, jobId, { gpu_seconds: result.gpuSeconds });
    await tx`
      insert into usage_events (org_id, kind, quantity) values (${orgId}, 'gpu_seconds', ${result.gpuSeconds})`;

    return true;
  });
}

/**
 * Records a failure, and decides whether it is worth another attempt.
 *
 * Retrying an out-of-memory job on the same worker would fail the same way, so only failures that
 * could plausibly be transient go back into the queue.
 */
export async function failJob(
  sql: Sql,
  jobId: string,
  workerId: string,
  failure: { code: FailureCode; message: string },
): Promise<'requeued' | 'failed' | 'ignored'> {
  return withStaff(sql, (tx) =>
    recordFailure(tx, TABLE, jobId, workerId, failure, {
      // Only a crash or an internal error could go differently next time. An out-of-memory job
      // retried on the same worker fails the same way, and a missing asset stays missing.
      retryable: (code) => code === 'renderer_crash' || code === 'internal',
    }),
  );
}

/**
 * Requeues jobs whose worker stopped reporting, and gives up on those that have used their attempts.
 *
 * This is what makes a killed worker a delay rather than a lost render.
 */
/**
 * Job durability (F-PLAT-01).
 *
 * A worker that dies mid-render holds a lease that stops being renewed; this gives the job back to
 * the queue when it lapses, up to a bounded number of attempts, and quarantines it as failed once
 * those are spent rather than cycling it forever.
 */
export async function sweepStaleJobs(sql: Sql): Promise<{ requeued: number; failed: number }> {
  return withStaff(sql, (tx) =>
    sweepStale(tx, TABLE, { code: 'renderer_crash', message: 'The renderer stopped responding.' }),
  );
}

// -----------------------------------------------------------------------------------------------

/**
 * Limits are the schema's defaults unless the organisation has its own row.
 *
 * A missing row must not mean "unlimited": that turns a data gap into an uncapped bill, and the
 * failure would be silent until someone read an invoice.
 */
const DEFAULT_QUOTA = { rendersPerDay: 50, maxConcurrentJobs: 3 };

/**
 * Refuses a submission that would put an organisation over its render quota (F-PLAT-04).
 *
 * The counting, the lock and the race it closes are in `@pr/job-queue`; what is render-specific is
 * which two numbers out of `org_quotas` are the limits.
 */
async function assertWithinQuota(tx: Tx, orgId: string): Promise<void> {
  const [row] = await tx`
    select renders_per_day, max_concurrent_jobs from org_quotas where org_id = ${orgId}`;

  await assertQuota(tx, {
    table: TABLE,
    lockName: 'render_quota',
    orgId,
    limits: {
      perDay: row ? Number(row['renders_per_day']) : DEFAULT_QUOTA.rendersPerDay,
      maxConcurrent: row ? Number(row['max_concurrent_jobs']) : DEFAULT_QUOTA.maxConcurrentJobs,
    },
  });
}

async function findByHash(tx: Tx, hash: Buffer): Promise<RenderJob | null> {
  const [row] = await tx`
    select * from render_jobs
    where spec_hash = ${hash} and status in ('queued', 'running', 'succeeded')`;
  if (!row) return null;
  const outputs = await outputsFor(tx, [row['id'] as string]);
  return toJob(row, outputs.get(row['id'] as string) ?? []);
}

async function findById(tx: Tx, jobId: string): Promise<RenderJob | null> {
  const [row] = await tx`select * from render_jobs where id = ${jobId}`;
  if (!row) return null;
  const outputs = await outputsFor(tx, [jobId]);
  return toJob(row, outputs.get(jobId) ?? []);
}

async function outputsFor(tx: Tx, jobIds: string[]): Promise<Map<string, RenderOutput[]>> {
  const byJob = new Map<string, RenderOutput[]>();
  if (jobIds.length === 0) return byJob;

  const rows = await tx`
    select job_id, kind, storage_key, width, height, format, bytes,
           web_storage_key, web_bytes, provenance
    from render_outputs where job_id in ${tx(jobIds)} order by storage_key`;

  for (const row of rows) {
    const list = byJob.get(row['job_id'] as string) ?? [];
    list.push({
      kind: row['kind'] as RenderOutput['kind'],
      storageKey: row['storage_key'] as string,
      ...(row['width'] !== null ? { width: row['width'] as number } : {}),
      ...(row['height'] !== null ? { height: row['height'] as number } : {}),
      ...(row['format'] !== null ? { format: row['format'] as string } : {}),
      ...(row['bytes'] !== null ? { bytes: Number(row['bytes']) } : {}),
      ...(row['web_storage_key'] !== null
        ? { webStorageKey: row['web_storage_key'] as string }
        : {}),
      ...(row['web_bytes'] !== null ? { webBytes: Number(row['web_bytes']) } : {}),
      provenance: row['provenance'] as Record<string, unknown>,
    });
    byJob.set(row['job_id'] as string, list);
  }
  return byJob;
}

function toJob(row: Record<string, unknown>, outputs: RenderOutput[]): RenderJob {
  const spec = row['spec'] as RenderSpec;
  const estimate = estimateRender(spec);

  return {
    id: row['id'] as string,
    status: row['status'] as JobStatus,
    stage: (row['stage'] as string | null) ?? null,
    progress: Number(row['progress']),
    attempts: row['attempts'] as number,
    designVersionId: row['design_version_id'] as string,
    estimateSeconds: Math.round(estimate.seconds),
    estimateCents: Number(row['cost_estimate_cents'] ?? 0),
    error: (row['error'] as RenderJob['error']) ?? null,
    queuedAt: (row['queued_at'] as Date).toISOString(),
    startedAt: row['started_at'] ? (row['started_at'] as Date).toISOString() : null,
    finishedAt: row['finished_at'] ? (row['finished_at'] as Date).toISOString() : null,
    outputs,
  };
}
