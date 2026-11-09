import { listWorkers } from '@pr/admin/status';
import { CONCERN_TEXT, jobConcerns } from '@pr/job-queue';
import { listAllJobs, queueSnapshot, type JobStatus } from '@pr/render-jobs';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { JobRow } from './job-row';
import { RetryFailed } from './retry-failed';

/**
 * Running the queue (F-ADM-07).
 *
 * The three questions an operator actually has: is anything stuck, what is each worker doing, and
 * why did that one fail. Everything on this page answers one of them.
 */
export const dynamic = 'force-dynamic';

const FILTERS: (JobStatus | 'all')[] = ['all', 'queued', 'running', 'failed', 'succeeded', 'canceled'];

export default async function AdminQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireStaff();
  const { status } = await searchParams;
  const filter = FILTERS.includes(status as JobStatus) ? (status as JobStatus) : undefined;
  const sql = getSql();

  const [snapshot, jobs, registry] = await Promise.all([
    queueSnapshot(sql),
    listAllJobs(sql, { ...(filter ? { status: filter } : {}) }),
    listWorkers(sql),
  ]);

  const waiting = snapshot.oldestQueuedSec;
  const renderWorkers = registry.filter((w) => w.kind === 'render');
  const liveness = new Map(renderWorkers.map((w) => [w.id, w.liveness]));
  const alive = renderWorkers.filter((w) => w.liveness === 'alive').length;
  const now = new Date();
  const concernsOf = (job: (typeof jobs)[number]) =>
    jobConcerns(
      {
        status: job.status,
        queuedAt: new Date(job.queuedAt),
        startedAt: job.startedAt ? new Date(job.startedAt) : null,
        leaseExpiresAt: job.leaseExpiresAt ? new Date(job.leaseExpiresAt) : null,
        workerId: job.workerId,
        estimateSeconds: job.estimateSeconds,
      },
      liveness,
      alive,
      now,
    );
  // Workers that are running, or stopped within the hour: a week of clean restarts is not news.
  const shown = renderWorkers.filter((w) => w.liveness === 'alive' || w.liveness === 'stale' || w.silentSec < 3600);
  const holding = new Map(snapshot.workers.map((w) => [w.workerId, w]));

  return (
    <section data-testid="queue">
      <header className="admin-head">
        <div>
          <h1>Render queue</h1>
          <p className="auth-sub">
            {snapshot.counts.running} running · {snapshot.counts.queued} queued ·{' '}
            {snapshot.counts.failed} failed
            {waiting !== null && waiting > 0 ? ` · oldest waiting ${formatAge(waiting)}` : ''}
          </p>
        </div>
        <RetryFailed count={snapshot.counts.failed} />
      </header>

      <div className="queue-stats" data-testid="queue-stats">
        {(Object.keys(snapshot.counts) as JobStatus[]).map((key) => (
          <a
            key={key}
            href={`/admin/queue?status=${key}`}
            className={filter === key ? 'queue-stat active' : 'queue-stat'}
            data-testid={`queue-filter-${key}`}
          >
            <strong>{snapshot.counts[key]}</strong>
            <span>{key}</span>
          </a>
        ))}
        <a href="/admin/queue" className={filter ? 'queue-stat' : 'queue-stat active'}>
          <strong>{Object.values(snapshot.counts).reduce((a, b) => a + b, 0)}</strong>
          <span>all</span>
        </a>
      </div>

      <h2>Workers</h2>
      {shown.length === 0 ? (
        <p className="auth-sub" data-testid="no-workers">
          No render worker is running. Renders wait in the queue until one starts.
        </p>
      ) : (
        <ul className="admin-audit" data-testid="workers">
          {shown.map((worker) => {
            const job = holding.get(worker.id);
            return (
              <li key={worker.id} data-testid={`worker-${worker.id}`} data-liveness={worker.liveness}>
                <code>{worker.id}</code>
                <span>
                  <span className={`pill ${LIVENESS_PILL[worker.liveness]}`}>{worker.liveness}</span>{' '}
                  {job ? `${job.jobId.slice(0, 8)} · ${job.stage ?? 'starting'}` : 'idle'}
                </span>
                <small>
                  {worker.liveness === 'alive' ? `reported ${worker.silentSec}s ago` : `silent for ${formatAge(worker.silentSec)}`}
                </small>
              </li>
            );
          })}
        </ul>
      )}

      <h2>Jobs</h2>
      <div className="table-wrap">
        <table className="admin-table" data-testid="job-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Organization</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Time</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} concerns={concernsOf(job)} concernText={CONCERN_TEXT} />
            ))}
          </tbody>
        </table>
      </div>
      {jobs.length === 0 && (
        <p className="auth-sub" data-testid="queue-empty">
          Nothing here.
        </p>
      )}
    </section>
  );
}

const LIVENESS_PILL = { alive: 'ok', stale: 'warn', gone: 'bad', stopped: '' } as const;

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
