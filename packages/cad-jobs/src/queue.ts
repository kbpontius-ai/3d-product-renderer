import { uuidv7, withStaff, withTenant, type Sql, type TenantContext, type Tx } from '@pr/db';
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
import {
  isPermanentFailure,
  type CadFailureCode,
  type CadFormat,
  type CadImportResult,
  type CadIssue,
} from '@pr/cad';

/**
 * The CAD ingestion queue (docs/23-cad-ingestion.md).
 *
 * The render queue's twin, and deliberately so: the lease, the attempt cap, the sweep and the quota
 * race are the same code, in `@pr/job-queue`. What differs is what a job *is* — a supplier's file
 * rather than a design, a kernel rather than a renderer, minutes rather than seconds.
 *
 * Two things it does not share. Ingestion dedupes on the source file's digest together with the
 * pipeline version, because "the same file" is only the same work while the pipeline that reads it
 * has not changed. And almost every way an import fails is the file's fault rather than the
 * worker's, so retrying is the exception here where it is the rule for renders.
 */

export { DEFAULT_LEASE_SEC, MAX_ATTEMPTS, QueueError, type JobStatus };

const TABLE = 'cad_jobs';

/** Which worker class a job needs. The queue routes on it; the file's size and shape count set it. */
export type CadProfile = 'wasm' | 'standard' | 'heavy';

export interface CadJob {
  id: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  sourceKey: string;
  sourceName: string | null;
  sourceBytes: number;
  format: CadFormat;
  profile: CadProfile;
  importerId: string | null;
  importerVersion: string | null;
  pipelineVersion: string;
  /**
   * `findings` is every reason a result was refused, not the first one.
   *
   * An operator who is shown one of three re-exports, waits for another import, and is shown the
   * second has been made to do the work three times. The column is `jsonb` and always was, so this
   * costs no migration.
   */
  error: { code: CadFailureCode; message: string; findings?: CadIssue[] } | null;
  result: CadImportResult | null;
  packId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SubmitCadResult {
  job: CadJob;
  /** True when this file was already queued, running or ingested at this pipeline version. */
  deduped: boolean;
}

export interface SubmitCadInput {
  /** Storage key under `cad-source/`, which the asset route denies by name. */
  sourceKey: string;
  sourceName?: string;
  sourceBytes: number;
  /** sha256 of the file. Sniffed and hashed by the caller, before any of it reaches a parser. */
  sourceDigest: Buffer;
  format: CadFormat;
  pipelineVersion: string;
  profile?: CadProfile;
  priority?: number;
  traceId?: string;
}

/**
 * Queues an ingestion.
 *
 * Staff-only is enforced at the API, not here: the table's policy is ordinary tenancy, so the day
 * customer upload is allowed it is a decision rather than a migration.
 */
export async function submitIngestion(
  sql: Sql,
  ctx: TenantContext,
  input: SubmitCadInput,
): Promise<SubmitCadResult> {
  return withTenant(sql, ctx, async (tx) => {
    const existing = await findByDigest(tx, input.sourceDigest, input.pipelineVersion);
    if (existing) return { job: existing, deduped: true };

    await assertWithinQuota(tx, ctx.orgId);

    const id = uuidv7();
    try {
      await tx`
        insert into cad_jobs
          (id, org_id, submitted_by, source_key, source_name, source_bytes, source_digest,
           format, profile, pipeline_version, priority, trace_id)
        values
          (${id}, ${ctx.orgId}, ${ctx.userId}, ${input.sourceKey}, ${input.sourceName ?? null},
           ${input.sourceBytes}, ${input.sourceDigest}, ${input.format},
           ${input.profile ?? 'standard'}, ${input.pipelineVersion}, ${input.priority ?? 100},
           ${input.traceId ?? null})`;
    } catch (error) {
      // Two operators uploading the same supplier file within a second of each other: the loser
      // reads the winner's job rather than failing.
      if (isUniqueViolation(error)) {
        const raced = await findByDigest(tx, input.sourceDigest, input.pipelineVersion);
        if (raced) return { job: raced, deduped: true };
      }
      throw error;
    }

    return { job: (await findById(tx, id))!, deduped: false };
  });
}

export async function listIngestions(sql: Sql, ctx: TenantContext, limit = 25): Promise<CadJob[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`select * from cad_jobs order by queued_at desc limit ${limit}`;
    return rows.map(toJob);
  });
}

export async function findIngestionByMeshDigest(
  sql: Sql,
  ctx: TenantContext,
  digest: string,
): Promise<CadJob | null> {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await tx`select * from cad_jobs
      where status = 'succeeded' and exists (
        select 1 from jsonb_array_elements(result->'meshes') mesh where mesh->>'digest' = ${digest}
      ) order by finished_at desc limit 1`;
    return row ? toJob(row) : null;
  });
}

export async function getIngestion(sql: Sql, ctx: TenantContext, jobId: string): Promise<CadJob> {
  return withTenant(sql, ctx, async (tx) => {
    const job = await findById(tx, jobId);
    if (!job) throw new QueueError('not_found');
    return job;
  });
}

/**
 * Stops an ingestion.
 *
 * A running one is marked canceled and its worker finds out at its next heartbeat — which matters
 * more here than for a render, because a heavy import holds a container for an hour.
 */
export async function cancelIngestion(
  sql: Sql,
  ctx: TenantContext,
  jobId: string,
): Promise<CadJob> {
  return withTenant(sql, ctx, async (tx) => {
    if (!(await cancelPending(tx, TABLE, jobId, ctx.userId))) {
      const job = await findById(tx, jobId);
      if (!job) throw new QueueError('not_found');
      throw new QueueError('not_cancelable', `job is ${job.status}`);
    }
    return (await findById(tx, jobId))!;
  });
}

// --- worker side -------------------------------------------------------------------------------
// These run without a tenant: a worker serves every organisation, and the job row carries the one
// it belongs to.

export interface CadClaim {
  jobId: string;
  orgId: string;
  sourceKey: string;
  sourceName: string | null;
  sourceBytes: number;
  /** sha256 of the file as submitted. A file that no longer matches is a different ingestion. */
  sourceDigest: Buffer;
  format: CadFormat;
  profile: CadProfile;
  pipelineVersion: string;
  attempts: number;
  traceId: string | null;
}

export async function claimIngestion(
  sql: Sql,
  workerId: string,
  leaseSec = DEFAULT_LEASE_SEC,
): Promise<CadClaim | null> {
  return withStaff(sql, async (tx) => {
    const row = await claimNext(tx, TABLE, workerId, leaseSec);
    if (!row) return null;

    return {
      jobId: row['id'] as string,
      orgId: row['org_id'] as string,
      sourceKey: row['source_key'] as string,
      sourceName: (row['source_name'] as string | null) ?? null,
      sourceBytes: Number(row['source_bytes']),
      sourceDigest: row['source_digest'] as Buffer,
      format: row['format'] as CadFormat,
      profile: row['profile'] as CadProfile,
      pipelineVersion: row['pipeline_version'] as string,
      attempts: row['attempts'] as number,
      traceId: (row['trace_id'] as string | null) ?? null,
    };
  });
}

export async function heartbeatIngestion(
  sql: Sql,
  jobId: string,
  workerId: string,
  update: { stage?: string; progress?: number } = {},
  leaseSec = DEFAULT_LEASE_SEC,
): Promise<boolean> {
  return withStaff(sql, (tx) => heartbeatJob(tx, TABLE, jobId, workerId, update, leaseSec));
}

/**
 * Records what an import produced.
 *
 * The result is stored whole. An operator asking what a file turned into is asking about this, and
 * re-running a sixty-minute import to answer them is not a reasonable alternative to a jsonb column.
 */
export async function completeIngestion(
  sql: Sql,
  jobId: string,
  workerId: string,
  outcome: { result: CadImportResult; cpuSeconds: number },
): Promise<boolean> {
  return withStaff(sql, async (tx) => {
    const job = await heldBy(tx, TABLE, jobId, workerId);
    if (!job) return false;

    await markSucceeded(tx, TABLE, jobId, {
      result: tx.json(outcome.result as never),
      importer_id: outcome.result.importerId,
      importer_version: outcome.result.importerVersion,
      cpu_seconds: outcome.cpuSeconds,
    });
    await tx`
      insert into usage_events (org_id, kind, quantity)
      values (${job['org_id'] as string}, 'cad_cpu_seconds', ${outcome.cpuSeconds})`;

    return true;
  });
}

/**
 * The failures worth another attempt: every one of them describes the *worker*.
 *
 * Retrying is the exception here where it is the rule for renders. A STEP file with an unsupported
 * schema will still have one in ninety seconds; an assembly too complex for the heavy profile does
 * not get simpler on a second machine; a job that ran out of memory or out of time will do it again
 * on identical hardware. Only a kernel that crashed or was not there could go differently.
 *
 * `@pr/cad` names the complementary set as `PERMANENT_FAILURES`, and `retryableIsNotPermanent`
 * below is what keeps the two from drifting apart.
 */
export const RETRYABLE_FAILURES: readonly CadFailureCode[] = [
  'importer_crash',
  'importer_unavailable',
  'internal',
];

/** True when the two lists still disagree about nothing. Asserted in the tests, not at runtime. */
export const retryableIsNotPermanent = (): boolean =>
  RETRYABLE_FAILURES.every((code) => !isPermanentFailure(code));

/** Records a failure, and decides whether it is worth another attempt. */
export async function failIngestion(
  sql: Sql,
  jobId: string,
  workerId: string,
  failure: { code: CadFailureCode; message: string; findings?: CadIssue[] },
): Promise<'requeued' | 'failed' | 'ignored'> {
  return withStaff(sql, (tx) =>
    recordFailure(tx, TABLE, jobId, workerId, failure, {
      retryable: (code) => RETRYABLE_FAILURES.includes(code as CadFailureCode),
    }),
  );
}

/** Gives back the jobs whose worker stopped reporting, and quarantines those out of attempts. */
export async function sweepStaleIngestions(
  sql: Sql,
): Promise<{ requeued: number; failed: number }> {
  return withStaff(sql, (tx) =>
    sweepStale(tx, TABLE, { code: 'importer_crash', message: 'The importer stopped responding.' }),
  );
}

// -----------------------------------------------------------------------------------------------

/**
 * Limits are the schema's defaults unless the organisation has its own row.
 *
 * Lower than the render limits, and for a different reason: an ingestion is minutes of CPU on a
 * container with 8–32 GB of memory, so the cost of letting one loose is a machine rather than an
 * invoice line.
 */
const DEFAULT_QUOTA = { ingestsPerDay: 20, maxConcurrent: 2 };

async function assertWithinQuota(tx: Tx, orgId: string): Promise<void> {
  const [row] = await tx`
    select cad_ingests_per_day, max_concurrent_cad_jobs from org_quotas where org_id = ${orgId}`;

  await assertQuota(tx, {
    table: TABLE,
    lockName: 'cad_quota',
    orgId,
    limits: {
      perDay: row ? Number(row['cad_ingests_per_day']) : DEFAULT_QUOTA.ingestsPerDay,
      maxConcurrent: row ? Number(row['max_concurrent_cad_jobs']) : DEFAULT_QUOTA.maxConcurrent,
    },
  });
}

async function findByDigest(
  tx: Tx,
  digest: Buffer,
  pipelineVersion: string,
): Promise<CadJob | null> {
  const [row] = await tx`
    select * from cad_jobs
    where source_digest = ${digest} and pipeline_version = ${pipelineVersion}
      and status in ('queued', 'running', 'succeeded')`;
  return row ? toJob(row) : null;
}

async function findById(tx: Tx, jobId: string): Promise<CadJob | null> {
  const [row] = await tx`select * from cad_jobs where id = ${jobId}`;
  return row ? toJob(row) : null;
}

function toJob(row: Record<string, unknown>): CadJob {
  return {
    id: row['id'] as string,
    status: row['status'] as JobStatus,
    stage: (row['stage'] as string | null) ?? null,
    progress: Number(row['progress']),
    attempts: row['attempts'] as number,
    sourceKey: row['source_key'] as string,
    sourceName: (row['source_name'] as string | null) ?? null,
    sourceBytes: Number(row['source_bytes']),
    format: row['format'] as CadFormat,
    profile: row['profile'] as CadProfile,
    importerId: (row['importer_id'] as string | null) ?? null,
    importerVersion: (row['importer_version'] as string | null) ?? null,
    pipelineVersion: row['pipeline_version'] as string,
    error: (row['error'] as CadJob['error']) ?? null,
    result: (row['result'] as CadImportResult | null) ?? null,
    packId: (row['pack_id'] as string | null) ?? null,
    queuedAt: (row['queued_at'] as Date).toISOString(),
    startedAt: row['started_at'] ? (row['started_at'] as Date).toISOString() : null,
    finishedAt: row['finished_at'] ? (row['finished_at'] as Date).toISOString() : null,
  };
}
