import { withStaff, type Sql } from '@pr/db';
import { queueTable } from './lease.js';

/**
 * The worker registry, and each job's own log (F-ADM-07, W-13).
 *
 * A worker registers when it starts, reports every `WORKER_HEARTBEAT_SEC` whether or not it holds a
 * job, and says so when it stops cleanly. The job lease already proved a job's worker was alive, but
 * only while it held a job, and only once the lease ran out — two minutes of a dead worker looking
 * busy. The registry answers "which workers are there, and are they alive" directly.
 */

export type WorkerKind = 'render' | 'cad';

export interface WorkerRegistration {
  id: string;
  kind: WorkerKind;
  host: string;
  pid: number;
  engine?: string;
  engineVersion?: string;
}

/** Rows for workers not seen in this long are removed when another worker starts. */
const FORGET_AFTER_DAYS = 7;

export async function registerWorker(sql: Sql, worker: WorkerRegistration): Promise<void> {
  await withStaff(sql, async (tx) => {
    await tx`
      insert into workers (id, kind, host, pid, engine, engine_version)
      values (${worker.id}, ${worker.kind}, ${worker.host}, ${worker.pid},
              ${worker.engine ?? null}, ${worker.engineVersion ?? null})
      on conflict (id) do update
        set kind = excluded.kind, host = excluded.host, pid = excluded.pid, engine = excluded.engine,
            engine_version = excluded.engine_version, started_at = now(), last_seen_at = now(),
            stopped_at = null, current_job_id = null`;
    await tx`delete from workers where last_seen_at < now() - make_interval(days => ${FORGET_AFTER_DAYS})`;
  });
}

export async function touchWorker(sql: Sql, id: string, currentJobId: string | null): Promise<void> {
  await withStaff(sql, (tx) => tx`
    update workers set last_seen_at = now(), current_job_id = ${currentJobId}, stopped_at = null
    where id = ${id}`);
}

export async function stopWorker(sql: Sql, id: string): Promise<void> {
  await withStaff(sql, (tx) => tx`
    update workers set stopped_at = now(), last_seen_at = now(), current_job_id = null where id = ${id}`);
}

/**
 * Keeps a worker's registry row current until `stop` is called.
 *
 * Its own timer rather than the job heartbeat, because a worker waiting for work has no job to beat
 * for — and "idle" and "dead" must not look the same. A failed report is ignored: the next one may
 * succeed, and a worker that cannot reach the database has louder problems than its registry row.
 */
export function keepWorkerAlive(
  sql: Sql,
  id: string,
  currentJob: () => string | null,
  intervalSec: number,
): { stop: () => Promise<void> } {
  const timer = setInterval(() => {
    touchWorker(sql, id, currentJob()).catch(() => {});
  }, intervalSec * 1000);
  timer.unref();

  return {
    stop: async () => {
      clearInterval(timer);
      await stopWorker(sql, id).catch(() => {});
    },
  };
}

// --- a job's own log ------------------------------------------------------------------------------

export interface JobLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

/** The newest lines a job keeps. A job that retries three times still fits comfortably. */
export const JOB_LOG_KEEP = 200;
/** A field that serialises longer than this is shortened: a log line is not a place for a payload. */
const FIELD_MAX_CHARS = 500;

/** The fields a line always carries in the worker's own log, and that would only repeat here. */
const IMPLIED = new Set(['workerId', 'jobId', 'orgId', 'requestId']);

/** Appends lines to a job's log, keeping only the newest `keep`. */
export async function appendJobLog(
  sql: Sql,
  table: string,
  jobId: string,
  lines: JobLogLine[],
  keep = JOB_LOG_KEEP,
): Promise<void> {
  if (lines.length === 0) return;
  await withStaff(sql, (tx) => tx`
    update ${tx(queueTable(table))}
    set log = (
      select coalesce(jsonb_agg(line order by n), '[]'::jsonb)
      from (
        select line, n
        from jsonb_array_elements(log || ${tx.json(lines as never)}::jsonb) with ordinality as t(line, n)
        order by n desc
        limit ${keep}
      ) newest
    )
    where id = ${jobId}`);
}

/** A log record as the logger writes it; structural, so this package needs no logger. */
export interface LoggedRecord {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
  error?: { name: string; message: string };
}

/**
 * Collects a job's log records and writes them to the job every `flushSec`, and once more at the end.
 *
 * Debug records stay in the process log: they are progress ticks, and a job's log is for what
 * happened, not for how fast. Writing periodically rather than per line keeps the database out of
 * the hot path; a worker that dies loses at most the last few seconds, which the service log has.
 */
export function jobLogWriter(sql: Sql, table: string, jobId: string, flushSec = 3) {
  let pending: JobLogLine[] = [];
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (pending.length === 0) return chain;
    const lines = pending;
    pending = [];
    chain = chain.then(() => appendJobLog(sql, table, jobId, lines)).catch(() => {});
    return chain;
  };

  const timer = setInterval(() => void flush(), flushSec * 1000);
  timer.unref();

  return {
    record(record: LoggedRecord): void {
      if (record.level === 'debug') return;
      pending.push(toLine(record));
    },
    async close(): Promise<void> {
      clearInterval(timer);
      await flush();
    },
  };
}

export function toLine(record: LoggedRecord): JobLogLine {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    if (IMPLIED.has(key)) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    fields[key] = text !== undefined && text.length > FIELD_MAX_CHARS ? `${text.slice(0, FIELD_MAX_CHARS)}…` : value;
  }
  if (record.error) fields['error'] = `${record.error.name}: ${record.error.message}`;

  return {
    at: record.time,
    level: record.level === 'debug' ? 'info' : record.level,
    message: record.message,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}
