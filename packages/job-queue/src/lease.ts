import type { Tx } from '@pr/db';

/**
 * The queue mechanics, shared between every kind of job (docs/23-cad-ingestion.md, "The shape of it").
 *
 * Postgres is the queue. `for update skip locked` is what makes that safe with several workers, and
 * a lease is what makes it safe when one of them dies mid-job: nothing is lost, the work is simply
 * claimable again once the lease lapses.
 *
 * This lives on its own because there is now more than one queue. The render queue's version of it
 * has been debugged in production shapes — including a quota race that only a saturation test
 * found — and a copy of that code in the CAD worker would be a copy of the bug it no longer has.
 * What differs between queues is the columns and the vocabulary of failure, so those are arguments;
 * the lease, the attempt cap and the sweep are not.
 *
 * Every function here takes a transaction rather than a pool, so the caller decides the boundary —
 * completing a job and writing what it produced belong in one transaction, and only the caller
 * knows what "what it produced" is.
 */

export const MAX_ATTEMPTS = 3;
export const DEFAULT_LEASE_SEC = 120;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export class QueueError extends Error {
  constructor(
    readonly code: 'not_found' | 'quota_exceeded' | 'too_many_running' | 'not_cancelable' | 'not_retryable',
    message?: string,
    readonly detail?: unknown,
  ) {
    super(message ?? code);
    this.name = 'QueueError';
  }
}

/**
 * An identifier, checked before it is interpolated.
 *
 * `sql(name)` quotes an identifier properly, so this is not what stands between the queue and an
 * injection. It is what stands between a typo and a confusing error, and it makes the fact that
 * these names are code rather than data explicit at the boundary — the one place in this file
 * where a string becomes SQL structure rather than a SQL value.
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

const identifier = (name: string, what: string): string => {
  if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a ${what} name`);
  return name;
};

export const queueTable = (name: string): string => identifier(name, 'queue table');

/**
 * Takes the next job, if there is one.
 *
 * `skip locked` is the whole trick: a second worker arriving during the first one's transaction
 * steps over the locked row and takes the next, rather than waiting behind it. Ordering is by
 * priority then age, so a stale high-priority job cannot be starved by a stream of new ones.
 *
 * Returns the whole row. Which columns matter is the caller's business, and a shared claim that
 * tried to know would need to learn every queue's schema.
 */
export async function claimNext(
  tx: Tx,
  table: string,
  workerId: string,
  leaseSec = DEFAULT_LEASE_SEC,
): Promise<Record<string, unknown> | null> {
  const name = queueTable(table);
  const [row] = await tx`
    update ${tx(name)}
    set status = 'running', worker_id = ${workerId}, started_at = coalesce(started_at, now()),
        attempts = attempts + 1, stage = 'claimed', progress = 0,
        lease_expires_at = now() + make_interval(secs => ${leaseSec})
    where id = (
      select id from ${tx(name)}
      where status = 'queued'
      order by priority, queued_at
      limit 1
      for update skip locked
    )
    returning *`;

  return row ?? null;
}

/**
 * Extends the lease and reports where the job has got to.
 *
 * Returns false when the job is no longer this worker's to run — cancelled, or swept and reclaimed
 * by someone else. A worker that sees false stops immediately: continuing would mean two workers
 * writing the same outputs.
 */
export async function heartbeatJob(
  tx: Tx,
  table: string,
  jobId: string,
  workerId: string,
  update: { stage?: string; progress?: number } = {},
  leaseSec = DEFAULT_LEASE_SEC,
): Promise<boolean> {
  const rows = await tx`
    update ${tx(queueTable(table))}
    set lease_expires_at = now() + make_interval(secs => ${leaseSec}),
        stage = coalesce(${update.stage ?? null}, stage),
        progress = coalesce(${update.progress ?? null}, progress)
    where id = ${jobId} and worker_id = ${workerId} and status = 'running'
    returning id`;
  return rows.length > 0;
}

/** Confirms this worker still holds the job, and hands back the row if it does. */
export async function heldBy(
  tx: Tx,
  table: string,
  jobId: string,
  workerId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx`
    select * from ${tx(queueTable(table))}
    where id = ${jobId} and worker_id = ${workerId} and status = 'running'`;
  return row ?? null;
}

/** Marks a held job finished. What it produced is the caller's to write, in the same transaction. */
export async function markSucceeded(
  tx: Tx,
  table: string,
  jobId: string,
  columns: Record<string, unknown> = {},
): Promise<void> {
  await tx`
    update ${tx(queueTable(table))}
    set status = 'succeeded', progress = 1, stage = 'done', finished_at = now(),
        lease_expires_at = null ${extra(tx, columns)}
    where id = ${jobId}`;
}

export interface FailureRecord {
  code: string;
  message: string;
}

/**
 * Records a failure, and decides whether it is worth another attempt.
 *
 * Retrying an out-of-memory job on the same worker would fail the same way, so the caller says
 * which codes could plausibly be transient. Everything that describes the input rather than the
 * worker is final on the first attempt: a STEP file with an unsupported schema will still have one
 * in ninety seconds, and a retry only spends another lease finding that out.
 */
export async function recordFailure(
  tx: Tx,
  table: string,
  jobId: string,
  workerId: string,
  failure: FailureRecord,
  options: { retryable: (code: string) => boolean; maxAttempts?: number },
): Promise<'requeued' | 'failed' | 'ignored'> {
  const name = queueTable(table);
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;

  const [row] = await tx`
    select attempts from ${tx(name)}
    where id = ${jobId} and worker_id = ${workerId} and status = 'running'`;
  if (!row) return 'ignored';

  if (options.retryable(failure.code) && (row['attempts'] as number) < maxAttempts) {
    await tx`
      update ${tx(name)}
      set status = 'queued', worker_id = null, lease_expires_at = null, stage = 'requeued',
          error = ${tx.json(failure as never)}
      where id = ${jobId}`;
    return 'requeued';
  }

  await tx`
    update ${tx(name)}
    set status = 'failed', finished_at = now(), lease_expires_at = null,
        error = ${tx.json(failure as never)}
    where id = ${jobId}`;
  return 'failed';
}

/**
 * Job durability (F-PLAT-01).
 *
 * A worker that dies mid-job holds a lease that stops being renewed; this gives the job back to the
 * queue when it lapses, up to a bounded number of attempts, and quarantines it as failed once those
 * are spent rather than cycling it forever. It is what makes a killed worker a delay rather than
 * lost work.
 */
export async function sweepStale(
  tx: Tx,
  table: string,
  staleFailure: FailureRecord,
  maxAttempts = MAX_ATTEMPTS,
): Promise<{ requeued: number; failed: number }> {
  const name = queueTable(table);

  const requeued = await tx`
    update ${tx(name)}
    set status = 'queued', worker_id = null, lease_expires_at = null, stage = 'requeued'
    where status = 'running' and lease_expires_at < now() and attempts < ${maxAttempts}
    returning id`;

  const failed = await tx`
    update ${tx(name)}
    set status = 'failed', finished_at = now(), lease_expires_at = null,
        error = ${tx.json(staleFailure as never)}
    where status = 'running' and lease_expires_at < now() and attempts >= ${maxAttempts}
    returning id`;

  return { requeued: requeued.length, failed: failed.length };
}

/**
 * Stops a job.
 *
 * A queued job stops existing as work; a running one is marked canceled and its worker finds out at
 * its next heartbeat, which is the only place it is safe to abandon a job from.
 */
export async function cancelPending(
  tx: Tx,
  table: string,
  jobId: string,
  canceledBy: string | null,
): Promise<boolean> {
  const rows = await tx`
    update ${tx(queueTable(table))}
    set status = 'canceled', finished_at = now(), canceled_by = ${canceledBy},
        error = ${tx.json({ code: 'canceled', message: 'Canceled.' } as never)}
    where id = ${jobId} and status in ('queued', 'running')
    returning id`;
  return rows.length > 0;
}

export interface QuotaLimits {
  /** Jobs this organisation may submit in a rolling day. */
  perDay: number;
  /** Jobs it may have queued or running at once. */
  maxConcurrent: number;
}

/**
 * Refuses a submission that would put an organisation over its quota (F-PLAT-04 spend controls).
 *
 * The lock is the whole point. Without it this reads a count and then inserts, and under
 * `read committed` fifty submissions arriving together all read the same count before any of them
 * has inserted — so all fifty pass a limit of ten. A saturation test found exactly that: thirteen
 * accepted against a limit of ten, and the number varying with timing is the tell.
 *
 * A transaction-scoped advisory lock keyed on the queue and the organisation serialises the
 * read-then-write for that organisation on that queue and nobody else. Submissions are a
 * human-paced action, so the contention this introduces is between one person's own tabs; the
 * alternative — a serialisable transaction with a retry loop — costs more and buys nothing here.
 *
 * It is taken before the count is read, because a lock acquired afterwards protects nothing.
 */
export async function assertWithinQuota(
  tx: Tx,
  options: { table: string; lockName: string; orgId: string; limits: QuotaLimits },
): Promise<void> {
  const name = queueTable(options.table);
  await tx`select pg_advisory_xact_lock(hashtext(${options.lockName}), hashtext(${options.orgId}))`;

  // Counted through RLS, so this is the caller's own organisation and no `where org_id` is needed —
  // adding one would suggest the isolation lives here rather than in the policy.
  const [counts] = await tx`
    select
      count(*) filter (where queued_at > now() - interval '1 day') as today,
      count(*) filter (where status in ('queued', 'running')) as live
    from ${tx(name)}`;

  const today = Number(counts!['today']);
  const live = Number(counts!['live']);

  if (today >= options.limits.perDay) {
    throw new QueueError('quota_exceeded', 'Daily limit reached.', { used: today, limit: options.limits.perDay });
  }
  if (live >= options.limits.maxConcurrent) {
    throw new QueueError('too_many_running', 'Too many jobs in flight.', {
      running: live,
      limit: options.limits.maxConcurrent,
    });
  }
}

/** `, a = 1, b = 2` — the columns a particular queue records on success, appended to a set list. */
function extra(tx: Tx, columns: Record<string, unknown>) {
  return Object.keys(columns).reduce(
    (fragment, column) => tx`${fragment}, ${tx(identifier(column, 'column'))} = ${columns[column] as never}`,
    tx``,
  );
}

export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
