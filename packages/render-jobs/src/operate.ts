import { recordAudit, withStaff, type Sql, type Tx } from '@pr/db';
import { estimateRender } from '@pr/render-spec';
import type { RenderSpec } from '@pr/design-schema';
import { QueueError, type FailureCode, type JobStatus, type RenderJob } from './queue.js';

/**
 * Queue operations for staff (F-ADM-07).
 *
 * The tenant-facing API in `queue.ts` is deliberately narrow: an organisation may look at its own
 * jobs and cancel them. Running the queue is a different job — seeing every organisation's work,
 * putting a failed job back, killing one that is holding a worker — and it crosses tenants, so it
 * lives apart, takes an actor, and writes an audit entry for anything it changes.
 */

export interface QueueJobView extends RenderJob {
  orgId: string;
  orgName: string;
  workerId: string | null;
  rendererVersion: string | null;
  gpuSeconds: number | null;
  /** How long each stage took, as the worker recorded it. Empty until a job finishes. */
  stages: Record<string, number>;
  traceId: string | null;
  leaseExpiresAt: string | null;
}

export interface QueueSnapshot {
  counts: Record<JobStatus, number>;
  /** The oldest thing still waiting, in seconds — the number that says whether to add workers. */
  oldestQueuedSec: number | null;
  /** Workers that have touched a job recently, with what they are doing. */
  workers: { workerId: string; jobId: string; stage: string | null; since: string }[];
}

const STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'canceled'];

export async function queueSnapshot(sql: Sql): Promise<QueueSnapshot> {
  return withStaff(sql, async (tx) => {
    const counts = await tx`select status, count(*)::int as n from render_jobs group by status`;
    const [oldest] = await tx`
      select extract(epoch from (now() - min(queued_at))) as age
      from render_jobs where status = 'queued'`;
    const workers = await tx`
      select worker_id, id, stage, started_at from render_jobs
      where status = 'running' and worker_id is not null
      order by started_at`;

    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
    for (const row of counts) byStatus[row['status'] as JobStatus] = Number(row['n']);

    return {
      counts: byStatus,
      oldestQueuedSec: oldest?.['age'] != null ? Math.round(Number(oldest['age'])) : null,
      workers: workers.map((row) => ({
        workerId: row['worker_id'] as string,
        jobId: row['id'] as string,
        stage: (row['stage'] as string | null) ?? null,
        since: (row['started_at'] as Date).toISOString(),
      })),
    };
  });
}

export async function listAllJobs(
  sql: Sql,
  options: { status?: JobStatus; orgId?: string; limit?: number } = {},
): Promise<QueueJobView[]> {
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select j.*, o.name as org_name
      from render_jobs j
      join organizations o on o.id = j.org_id
      where (${options.status ?? null}::text is null or j.status::text = ${options.status ?? null})
        and (${options.orgId ?? null}::uuid is null or j.org_id = ${options.orgId ?? null})
      order by
        case when j.status in ('running', 'queued') then 0 else 1 end,
        j.queued_at desc
      limit ${options.limit ?? 100}`;

    const outputs = await outputRows(tx, rows.map((r) => r['id'] as string));
    return rows.map((row) => toAdminJob(row, outputs.get(row['id'] as string) ?? []));
  });
}

export async function getJobForStaff(sql: Sql, jobId: string): Promise<QueueJobView> {
  const [job] = await listAllJobs(sql, {}).then((jobs) => jobs.filter((j) => j.id === jobId));
  if (job) return job;

  // Not in the recent window: fetch it directly rather than paging back through the queue.
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select j.*, o.name as org_name from render_jobs j
      join organizations o on o.id = j.org_id where j.id = ${jobId}`;
    const row = rows[0];
    if (!row) throw new QueueError('not_found');

    const outputs = await outputRows(tx, [jobId]);
    return toAdminJob(row, outputs.get(jobId) ?? []);
  });
}

/**
 * Puts a failed or cancelled job back on the queue.
 *
 * Attempts are reset: a staff retry is a considered decision, usually after fixing whatever the job
 * was failing on, and it should not be refused because the automatic retries were already spent.
 * A job that succeeded is refused: running it again renders the same pixels, charges the
 * organisation's quota and GPU time for them, and replaces nothing anyone asked to replace.
 */
export async function retryJob(sql: Sql, jobId: string, actorId: string | null): Promise<QueueJobView> {
  await withStaff(sql, async (tx) => {
    const [job] = await tx`select id, org_id, status from render_jobs where id = ${jobId}`;
    if (!job) throw new QueueError('not_found');
    if (job['status'] === 'queued' || job['status'] === 'running') {
      throw new QueueError('not_cancelable', `job is already ${job['status']}`);
    }
    if (job['status'] === 'succeeded') {
      throw new QueueError('not_retryable', 'job already succeeded; only a failed or cancelled job is retried');
    }

    await tx`
      update render_jobs
      set status = 'queued', attempts = 0, progress = 0, stage = 'requeued', error = null,
          worker_id = null, lease_expires_at = null, started_at = null, finished_at = null
      where id = ${jobId}`;

    await recordAudit(tx, {
      orgId: job['org_id'] as string,
      actorUserId: actorId,
      action: 'render.retried',
      targetType: 'render_job',
      targetId: jobId,
      metadata: { from: job['status'] },
    });
  });

  return getJobForStaff(sql, jobId);
}

/** Stops a job that is holding a worker. The worker notices at its next heartbeat and lets go. */
export async function cancelJobForStaff(
  sql: Sql,
  jobId: string,
  actorId: string | null,
  reason = 'Canceled by staff.',
): Promise<QueueJobView> {
  await withStaff(sql, async (tx) => {
    const rows = await tx`
      update render_jobs
      set status = 'canceled', finished_at = now(), canceled_by = ${actorId},
          error = ${tx.json({ code: 'canceled' as FailureCode, message: reason } as never)}
      where id = ${jobId} and status in ('queued', 'running')
      returning org_id, status`;

    if (rows.length === 0) {
      const [job] = await tx`select status from render_jobs where id = ${jobId}`;
      if (!job) throw new QueueError('not_found');
      throw new QueueError('not_cancelable', `job is ${job['status']}`);
    }

    await recordAudit(tx, {
      orgId: rows[0]!['org_id'] as string,
      actorUserId: actorId,
      action: 'render.canceled',
      targetType: 'render_job',
      targetId: jobId,
      metadata: { reason },
    });
  });

  return getJobForStaff(sql, jobId);
}

/** Requeues everything that failed for a given reason — the fix-then-replay move after an outage. */
export async function retryFailed(
  sql: Sql,
  options: { code?: FailureCode; limit?: number },
  actorId: string | null,
): Promise<number> {
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      update render_jobs
      set status = 'queued', attempts = 0, progress = 0, stage = 'requeued', error = null,
          worker_id = null, lease_expires_at = null, started_at = null, finished_at = null
      where id in (
        select id from render_jobs
        where status = 'failed'
          and (${options.code ?? null}::text is null or error->>'code' = ${options.code ?? null})
        order by finished_at desc
        limit ${options.limit ?? 50}
      )
      returning id, org_id`;

    for (const row of rows) {
      await recordAudit(tx, {
        orgId: row['org_id'] as string,
        actorUserId: actorId,
        action: 'render.retried',
        targetType: 'render_job',
        targetId: row['id'] as string,
        metadata: { bulk: true, code: options.code ?? 'any' },
      });
    }

    return rows.length;
  });
}

async function outputRows(tx: Tx, ids: string[]): Promise<Map<string, RenderJob['outputs']>> {
  const map = new Map<string, RenderJob['outputs']>();
  if (ids.length === 0) return map;

  const rows = await tx`
    select job_id, kind, storage_key, width, height, format, bytes, provenance
    from render_outputs where job_id = any(${ids})`;

  for (const row of rows) {
    const jobId = row['job_id'] as string;
    const list = map.get(jobId) ?? [];
    list.push({
      kind: row['kind'] as 'image',
      storageKey: row['storage_key'] as string,
      width: row['width'] as number,
      height: row['height'] as number,
      format: row['format'] as string,
      bytes: Number(row['bytes'] ?? 0),
      provenance: row['provenance'] as Record<string, unknown>,
    });
    map.set(jobId, list);
  }
  return map;
}

/**
 * A job as staff need to see it: the tenant view plus who ran it, on what, and how the time went.
 *
 * Stage timings come out of the finished job's provenance rather than a metrics backend — they were
 * written there by the worker precisely so this question could be answered about one job, later.
 */
function toAdminJob(row: Record<string, unknown>, outputs: RenderJob['outputs']): QueueJobView {
  const spec = row['spec'] as RenderSpec;
  const estimate = estimateRender(spec);
  const provenance = (outputs[0]?.provenance ?? {}) as { stages?: Record<string, number> };

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
    orgId: row['org_id'] as string,
    orgName: row['org_name'] as string,
    workerId: (row['worker_id'] as string | null) ?? null,
    rendererVersion: (row['renderer_version'] as string | null) ?? null,
    gpuSeconds: row['gpu_seconds'] != null ? Number(row['gpu_seconds']) : null,
    stages: provenance.stages ?? {},
    traceId: (row['trace_id'] as string | null) ?? null,
    leaseExpiresAt: row['lease_expires_at'] ? (row['lease_expires_at'] as Date).toISOString() : null,
  };
}
