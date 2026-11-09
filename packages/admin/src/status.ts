import { withStaff, type Sql, type Tx } from '@pr/db';
import {
  jobConcerns,
  workerLiveness,
  type JobConcern,
  type JobLogLine,
  type JobStatus,
  type WorkerKind,
  type WorkerLiveness,
} from '@pr/job-queue';
import { listAllJobs, type QueueJobView } from '@pr/render-jobs';

/**
 * What the platform is doing right now, in one read (the System Status page, F-ADM-15).
 *
 * Every number comes from the tables the platform already runs on — the queues, the worker
 * registry, the service event log — so the page cannot disagree with the system it describes. Times
 * are judged against the database's clock, the same one the heartbeats were written with, so a web
 * server whose clock drifts cannot make a live worker look dead.
 */

export interface WorkerView {
  id: string;
  kind: WorkerKind;
  host: string;
  pid: number;
  engine: string | null;
  engineVersion: string | null;
  startedAt: string;
  lastSeenAt: string;
  silentSec: number;
  liveness: WorkerLiveness;
  currentJobId: string | null;
}

export interface LiveRender {
  id: string;
  status: 'queued' | 'running';
  orgId: string;
  orgName: string;
  submittedBy: string | null;
  designName: string | null;
  stage: string | null;
  progress: number;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  estimateSeconds: number;
  workerId: string | null;
  /** Queued jobs only: where it stands in the line, 1 being next. */
  position: number | null;
  concerns: JobConcern[];
}

export interface LiveIngestion {
  id: string;
  status: 'queued' | 'running';
  orgName: string;
  sourceName: string | null;
  format: string;
  stage: string | null;
  progress: number;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  workerId: string | null;
  concerns: JobConcern[];
}

export interface ServiceEventView {
  id: number;
  at: string;
  service: string;
  level: 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
  error: { name: string; message: string; stack?: string } | null;
  requestId: string | null;
  jobId: string | null;
}

export interface SystemStatus {
  now: string;
  database: { latencyMs: number; sizeBytes: number; connections: number; migration: string | null };
  workers: WorkerView[];
  render: {
    counts: Record<JobStatus, number>;
    oldestQueuedSec: number | null;
    running: LiveRender[];
    queued: LiveRender[];
  };
  cad: { counts: Record<JobStatus, number>; inFlight: LiveIngestion[] };
  last24h: {
    succeeded: number;
    failed: number;
    canceled: number;
    medianSec: number | null;
    p95Sec: number | null;
    gpuSeconds: number;
    failuresByCode: { code: string; count: number }[];
    hourly: { hour: string; succeeded: number; failed: number }[];
  };
  /** Organisations at or near a limit — the ones about to be told "no". */
  nearLimit: {
    orgId: string;
    orgName: string;
    today: number;
    perDay: number;
    active: number;
    maxConcurrent: number;
  }[];
  events: {
    recent: ServiceEventView[];
    errorsLastHour: number;
    warningsLastHour: number;
    errorsLast24h: number;
    /** Sends the mail provider refused or could not be reached for, from the web app and the render worker. */
    mailFailures24h: number;
    services: string[];
  };
}

export interface StatusOptions {
  events?: { level?: 'warn' | 'error'; service?: string; limit?: number };
}

const STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
/** Near a limit: this share of the daily quota used. */
const NEAR_LIMIT = 0.8;

export async function systemStatus(sql: Sql, options: StatusOptions = {}): Promise<SystemStatus> {
  const started = performance.now();
  await sql`select 1`;
  const latencyMs = Math.round((performance.now() - started) * 10) / 10;

  const [running, queued] = await Promise.all([
    listAllJobs(sql, { status: 'running', limit: 200 }),
    listAllJobs(sql, { status: 'queued', limit: 200 }),
  ]);

  return withStaff(sql, async (tx) => {
    const [db] = await tx`
      select now() as now, pg_database_size(current_database())::bigint as size,
             (select count(*) from pg_stat_activity where datname = current_database())::int as connections,
             (select max(name) from schema_migrations) as migration`;
    const now = db!['now'] as Date;

    const workers = (await tx`select * from workers order by kind, started_at desc`).map((row) =>
      toWorker(row, now),
    );
    const liveness = new Map(workers.map((w) => [w.id, w.liveness]));
    const alive = (kind: WorkerKind) => workers.filter((w) => w.kind === kind && w.liveness === 'alive').length;

    const people = await namesFor(tx, [...running, ...queued]);
    // Oldest-first is the order the queue claims in (priority, then age); listAllJobs sorts newest first.
    const line = [...queued].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const toLive = (job: QueueJobView, position: number | null): LiveRender => ({
      id: job.id,
      status: job.status as 'queued' | 'running',
      orgId: job.orgId,
      orgName: job.orgName,
      submittedBy: people.get(job.id)?.email ?? null,
      designName: people.get(job.id)?.design ?? null,
      stage: job.stage,
      progress: job.progress,
      attempts: job.attempts,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      estimateSeconds: job.estimateSeconds,
      workerId: job.workerId,
      position,
      concerns: jobConcerns(
        {
          status: job.status,
          queuedAt: new Date(job.queuedAt),
          startedAt: job.startedAt ? new Date(job.startedAt) : null,
          leaseExpiresAt: job.leaseExpiresAt ? new Date(job.leaseExpiresAt) : null,
          workerId: job.workerId,
          estimateSeconds: job.estimateSeconds,
        },
        liveness,
        alive('render'),
        now,
      ),
    });

    const renderCounts = await countsFor(tx, 'render_jobs');
    const cadCounts = await countsFor(tx, 'cad_jobs');
    const [oldest] = await tx`
      select extract(epoch from (now() - min(queued_at))) as age from render_jobs where status = 'queued'`;

    const cadRows = await tx`
      select c.*, o.name as org_name from cad_jobs c join organizations o on o.id = c.org_id
      where c.status in ('queued', 'running') order by c.queued_at`;
    const inFlight: LiveIngestion[] = cadRows.map((row) => {
      const job = {
        status: row['status'] as JobStatus,
        queuedAt: row['queued_at'] as Date,
        startedAt: (row['started_at'] as Date | null) ?? null,
        leaseExpiresAt: (row['lease_expires_at'] as Date | null) ?? null,
        workerId: (row['worker_id'] as string | null) ?? null,
        // An ingestion has no estimate; the overdue floor is the whole rule.
        estimateSeconds: 0,
      };
      return {
        id: row['id'] as string,
        status: job.status as 'queued' | 'running',
        orgName: row['org_name'] as string,
        sourceName: (row['source_name'] as string | null) ?? null,
        format: row['format'] as string,
        stage: (row['stage'] as string | null) ?? null,
        progress: Number(row['progress']),
        attempts: row['attempts'] as number,
        queuedAt: job.queuedAt.toISOString(),
        startedAt: job.startedAt?.toISOString() ?? null,
        workerId: job.workerId,
        concerns: jobConcerns(job, liveness, alive('cad'), now),
      };
    });

    const [day] = await tx`
      select
        count(*) filter (where status = 'succeeded')::int as succeeded,
        count(*) filter (where status = 'failed')::int as failed,
        count(*) filter (where status = 'canceled')::int as canceled,
        percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at))
          filter (where status = 'succeeded' and started_at is not null) as median,
        percentile_cont(0.95) within group (order by extract(epoch from finished_at - started_at))
          filter (where status = 'succeeded' and started_at is not null) as p95,
        coalesce(sum(gpu_seconds), 0)::float as gpu
      from render_jobs where finished_at > now() - interval '24 hours'`;
    const failures = await tx`
      select coalesce(error->>'code', 'unknown') as code, count(*)::int as n
      from render_jobs where status = 'failed' and finished_at > now() - interval '24 hours'
      group by 1 order by 2 desc`;
    const hourly = await tx`
      select h.hour,
             count(j.id) filter (where j.status = 'succeeded')::int as succeeded,
             count(j.id) filter (where j.status = 'failed')::int as failed
      from generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') as h(hour)
      left join render_jobs j on j.finished_at >= h.hour and j.finished_at < h.hour + interval '1 hour'
      group by h.hour order by h.hour`;

    const quotas = await tx`
      select o.id, o.name, q.renders_per_day, q.max_concurrent_jobs,
             count(j.id) filter (where j.queued_at > now() - interval '1 day')::int as today,
             count(j.id) filter (where j.status in ('queued', 'running'))::int as active
      from organizations o
      join org_quotas q on q.org_id = o.id
      left join render_jobs j on j.org_id = o.id
      group by o.id, o.name, q.renders_per_day, q.max_concurrent_jobs`;

    const level = options.events?.level ?? null;
    const service = options.events?.service ?? null;
    const recent = await tx`
      select * from service_events
      where (${level}::text is null or level = ${level})
        and (${service}::text is null or service = ${service})
      order by id desc limit ${Math.min(Math.max(options.events?.limit ?? 100, 1), 500)}`;
    const [eventCounts] = await tx`
      select
        count(*) filter (where level = 'error' and at > now() - interval '1 hour')::int as errors_hour,
        count(*) filter (where level = 'warn' and at > now() - interval '1 hour')::int as warns_hour,
        count(*) filter (where level = 'error')::int as errors_day,
        count(*) filter (
          where message in ('could not send a message', 'could not send the render notification')
        )::int as mail_failures
      from service_events where at > now() - interval '24 hours'`;
    const services = await tx`select distinct service from service_events order by service`;

    return {
      now: now.toISOString(),
      database: {
        latencyMs,
        sizeBytes: Number(db!['size']),
        connections: Number(db!['connections']),
        migration: (db!['migration'] as string | null) ?? null,
      },
      workers,
      render: {
        counts: renderCounts,
        oldestQueuedSec: oldest?.['age'] != null ? Math.round(Number(oldest['age'])) : null,
        running: running.map((job) => toLive(job, null)),
        queued: line.map((job, index) => toLive(job, index + 1)),
      },
      cad: { counts: cadCounts, inFlight },
      last24h: {
        succeeded: day!['succeeded'] as number,
        failed: day!['failed'] as number,
        canceled: day!['canceled'] as number,
        medianSec: day!['median'] != null ? Math.round(Number(day!['median'])) : null,
        p95Sec: day!['p95'] != null ? Math.round(Number(day!['p95'])) : null,
        gpuSeconds: Math.round(Number(day!['gpu'])),
        failuresByCode: failures.map((r) => ({ code: r['code'] as string, count: r['n'] as number })),
        hourly: hourly.map((r) => ({
          hour: (r['hour'] as Date).toISOString(),
          succeeded: r['succeeded'] as number,
          failed: r['failed'] as number,
        })),
      },
      nearLimit: quotas
        .map((r) => ({
          orgId: r['id'] as string,
          orgName: r['name'] as string,
          today: r['today'] as number,
          perDay: r['renders_per_day'] as number,
          active: r['active'] as number,
          maxConcurrent: r['max_concurrent_jobs'] as number,
        }))
        .filter((o) => o.today >= o.perDay * NEAR_LIMIT || o.active >= o.maxConcurrent)
        .sort((a, b) => b.today / b.perDay - a.today / a.perDay),
      events: {
        recent: recent.map(toEvent),
        errorsLastHour: eventCounts!['errors_hour'] as number,
        warningsLastHour: eventCounts!['warns_hour'] as number,
        errorsLast24h: eventCounts!['errors_day'] as number,
        mailFailures24h: eventCounts!['mail_failures'] as number,
        services: services.map((r) => r['service'] as string),
      },
    };
  });
}

/** Every registered worker, judged against the database's clock. For the queue page's Workers panel. */
export async function listWorkers(sql: Sql): Promise<WorkerView[]> {
  return withStaff(sql, async (tx) => {
    const [{ now }] = (await tx`select now() as now`) as unknown as [{ now: Date }];
    const rows = await tx`select * from workers order by kind, started_at desc`;
    return rows.map((row) => toWorker(row, now));
  });
}

/** A job's own log, oldest first, as its worker wrote it. Empty for a job no worker has touched. */
export async function jobLog(sql: Sql, kind: WorkerKind, jobId: string): Promise<JobLogLine[]> {
  return withStaff(sql, async (tx) => {
    const [row] = await tx`select log from ${tx(kind === 'render' ? 'render_jobs' : 'cad_jobs')} where id = ${jobId}`;
    return (row?.['log'] as JobLogLine[] | undefined) ?? [];
  });
}

function toWorker(row: Record<string, unknown>, now: Date): WorkerView {
  const lastSeenAt = row['last_seen_at'] as Date;
  const stoppedAt = (row['stopped_at'] as Date | null) ?? null;
  return {
    id: row['id'] as string,
    kind: row['kind'] as WorkerKind,
    host: row['host'] as string,
    pid: row['pid'] as number,
    engine: (row['engine'] as string | null) ?? null,
    engineVersion: (row['engine_version'] as string | null) ?? null,
    startedAt: (row['started_at'] as Date).toISOString(),
    lastSeenAt: lastSeenAt.toISOString(),
    silentSec: Math.max(0, Math.round((now.getTime() - lastSeenAt.getTime()) / 1000)),
    liveness: workerLiveness({ lastSeenAt, stoppedAt }, now),
    currentJobId: (row['current_job_id'] as string | null) ?? null,
  };
}

function toEvent(row: Record<string, unknown>): ServiceEventView {
  return {
    id: Number(row['id']),
    at: (row['at'] as Date).toISOString(),
    service: row['service'] as string,
    level: row['level'] as 'warn' | 'error',
    message: row['message'] as string,
    fields: (row['fields'] as Record<string, unknown>) ?? {},
    error: (row['error'] as ServiceEventView['error']) ?? null,
    requestId: (row['request_id'] as string | null) ?? null,
    jobId: (row['job_id'] as string | null) ?? null,
  };
}

async function countsFor(tx: Tx, table: 'render_jobs' | 'cad_jobs'): Promise<Record<JobStatus, number>> {
  const rows = await tx`select status, count(*)::int as n from ${tx(table)} group by status`;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const row of rows) counts[row['status'] as JobStatus] = row['n'] as number;
  return counts;
}

/** Who asked for each render and which design it is: what a person looking at the page recognises. */
async function namesFor(tx: Tx, jobs: QueueJobView[]): Promise<Map<string, { email: string | null; design: string | null }>> {
  const map = new Map<string, { email: string | null; design: string | null }>();
  if (jobs.length === 0) return map;
  const rows = await tx`
    select j.id, u.email, d.name as design
    from render_jobs j
    left join users u on u.id = j.submitted_by
    left join design_versions v on v.id = j.design_version_id
    left join designs d on d.id = v.design_id
    where j.id = any(${jobs.map((j) => j.id)})`;
  for (const row of rows) {
    map.set(row['id'] as string, {
      email: (row['email'] as string | null) ?? null,
      design: (row['design'] as string | null) ?? null,
    });
  }
  return map;
}
