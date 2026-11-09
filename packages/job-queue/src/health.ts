import type { JobStatus } from './lease.js';

/**
 * Is a worker alive, and is a job stuck (F-ADM-07, W-14).
 *
 * Pure, so the rules can be read and tested apart from the queries that feed them. Before these, a
 * worker killed mid-render left its job showing "running, 20 %" for the two minutes until its lease
 * lapsed, indistinguishable from one that was working.
 */

/** How often a worker says it is alive. */
export const WORKER_HEARTBEAT_SEC = 10;
/** Three missed heartbeats: something is wrong, though it may yet recover. */
export const WORKER_STALE_SEC = 30;
/** Five minutes without a word: the process is gone. */
export const WORKER_GONE_SEC = 300;

/** A queued job waiting longer than this is worth someone's attention (W-14's "SLA"). */
export const QUEUED_TOO_LONG_SEC = 600;
/** Running this long past its estimate, or at least this long, whichever is later. */
const OVERDUE_FACTOR = 4;
const OVERDUE_FLOOR_SEC = 900;

export type WorkerLiveness = 'alive' | 'stale' | 'gone' | 'stopped';

export function workerLiveness(worker: { lastSeenAt: Date; stoppedAt: Date | null }, now: Date): WorkerLiveness {
  if (worker.stoppedAt) return 'stopped';
  const silentSec = (now.getTime() - worker.lastSeenAt.getTime()) / 1000;
  if (silentSec <= WORKER_STALE_SEC) return 'alive';
  if (silentSec <= WORKER_GONE_SEC) return 'stale';
  return 'gone';
}

export type JobConcern = 'lease_lapsed' | 'worker_silent' | 'overdue' | 'no_worker' | 'waiting_long';

export interface JobHealthInput {
  status: JobStatus;
  queuedAt: Date;
  startedAt: Date | null;
  leaseExpiresAt: Date | null;
  workerId: string | null;
  estimateSeconds: number;
}

/**
 * What is wrong with a job, if anything. Empty for a healthy one.
 *
 * `workers` is every registered worker's liveness by id; `aliveWorkers` how many of this queue's
 * kind are alive. A running job whose worker is not in the registry counts as silent: every worker
 * registers when it starts, so an unknown one is one that has not been heard from.
 */
export function jobConcerns(
  job: JobHealthInput,
  workers: ReadonlyMap<string, WorkerLiveness>,
  aliveWorkers: number,
  now: Date,
): JobConcern[] {
  const concerns: JobConcern[] = [];
  const ageSec = (since: Date) => (now.getTime() - since.getTime()) / 1000;

  if (job.status === 'running') {
    if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() < now.getTime()) concerns.push('lease_lapsed');
    if (job.workerId && workers.get(job.workerId) !== 'alive') concerns.push('worker_silent');
    if (job.startedAt && ageSec(job.startedAt) > Math.max(job.estimateSeconds * OVERDUE_FACTOR, OVERDUE_FLOOR_SEC)) {
      concerns.push('overdue');
    }
  }

  if (job.status === 'queued') {
    if (aliveWorkers === 0) concerns.push('no_worker');
    if (ageSec(job.queuedAt) > QUEUED_TOO_LONG_SEC) concerns.push('waiting_long');
  }

  return concerns;
}

/** One sentence per concern, for the person deciding what to do about it. */
export const CONCERN_TEXT: Record<JobConcern, string> = {
  lease_lapsed: 'Its lease has lapsed: the worker stopped renewing it. The next sweep puts it back in the queue.',
  worker_silent: 'The worker holding it has stopped reporting in. It has probably died.',
  overdue: 'Running far longer than its estimate.',
  no_worker: 'No worker is running to pick it up.',
  waiting_long: 'Waiting for more than ten minutes.',
};
