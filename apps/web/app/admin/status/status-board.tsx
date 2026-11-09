'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveRender, ServiceEventView, WorkerView } from '@pr/admin/status';
import type { JobConcern } from '@pr/job-queue';
import { bytes, duration, type Health, type ServiceCard } from '@/lib/system-status';
import type { StatusPayload } from '@/lib/server/system-status';

/**
 * The System Status board (F-ADM-15).
 *
 * Read top to bottom it answers, in order: is anything wrong, which service, what is running right
 * now, what is waiting, how the last day went, and what the servers have been complaining about.
 * It refreshes every few seconds; Pause holds the picture still while someone reads it.
 */

const REFRESH_MS = 5000;
const GROUPS: ServiceCard['group'][] = ['Serving', 'Data', 'Processing', 'Delivery'];
const OVERALL_TEXT = { operational: 'All systems operational', degraded: 'Degraded', outage: 'Outage' } as const;
const OVERALL_HEALTH: Record<StatusPayload['overall'], Health> = { operational: 'ok', degraded: 'warn', outage: 'down' };
const LIVENESS_HEALTH: Record<WorkerView['liveness'], Health | 'idle'> = {
  alive: 'ok',
  stale: 'warn',
  gone: 'down',
  stopped: 'idle',
};

export function StatusBoard({ initial }: { initial: StatusPayload }) {
  const [payload, setPayload] = useState(initial);
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [failed, setFailed] = useState(false);
  const [level, setLevel] = useState<'' | 'warn' | 'error'>('');
  const [service, setService] = useState('');
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const query = new URLSearchParams({ ...(level ? { level } : {}), ...(service ? { service } : {}) });
      const response = await fetch(`/api/admin/status?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      setPayload((await response.json()) as StatusPayload);
      setUpdatedAt(new Date());
      setFailed(false);
    } catch {
      // The page itself failing to refresh is news too: it is shown, and the last good picture kept.
      setFailed(true);
    } finally {
      inFlight.current = false;
    }
  }, [level, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [paused, refresh]);

  const { status, cards, concernText } = payload;
  const now = new Date(status.now).getTime();
  const since = (iso: string | null) => (iso ? Math.max(0, (now - new Date(iso).getTime()) / 1000) : 0);
  const attention = [
    ...cards.filter((c) => c.health !== 'ok').map((c) => ({ key: c.key, health: c.health, text: `${c.name}: ${c.summary}` })),
    ...[...status.render.running, ...status.render.queued]
      .filter((j) => j.concerns.length > 0)
      .map((j) => ({
        key: j.id,
        health: 'warn' as Health,
        text: `Render ${j.id.slice(0, 8)} (${j.orgName}): ${j.concerns.map((c) => concernText[c]).join(' ')}`,
      })),
    ...status.cad.inFlight
      .filter((j) => j.concerns.length > 0)
      .map((j) => ({
        key: j.id,
        health: 'warn' as Health,
        text: `Ingestion of ${j.sourceName ?? 'a file'}: ${j.concerns.map((c) => concernText[c]).join(' ')}`,
      })),
  ];

  return (
    <section className="status-board" data-testid="status">
      <header className="admin-head">
        <div>
          <h1>System status</h1>
          <p className="auth-sub">
            Every service behind the app, live. Updated {updatedAt.toLocaleTimeString()}
            {paused ? ' · paused' : ` · refreshes every ${REFRESH_MS / 1000}s`}
            {failed && <span className="admin-error"> · the last refresh failed; showing the previous one</span>}
          </p>
        </div>
        <div className="status-controls">
          <span className={`status-overall health-${OVERALL_HEALTH[payload.overall]}`} data-testid="status-overall">
            <Dot health={OVERALL_HEALTH[payload.overall]} /> {OVERALL_TEXT[payload.overall]}
          </span>
          <button type="button" onClick={() => setPaused(!paused)} data-testid="status-pause">
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" onClick={() => void refresh()} data-testid="status-refresh">
            Refresh now
          </button>
        </div>
      </header>

      <div className="status-attention" data-testid="status-attention">
        {attention.length === 0 ? (
          <p className="admin-ok">Nothing needs attention.</p>
        ) : (
          <ul>
            {attention.map((item) => (
              <li key={item.key} className={`health-${item.health}`}>
                <Dot health={item.health} /> {item.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>Services</h2>
      {GROUPS.map((group) => (
        <div key={group} className="status-group">
          <h3>{group}</h3>
          <div className="status-cards">
            {cards
              .filter((card) => card.group === group)
              .map((card) => (
                <article key={card.key} className={`status-card health-${card.health}`} data-testid={`service-${card.key}`} data-health={card.health}>
                  <header>
                    <Dot health={card.health} />
                    <strong>{card.name}</strong>
                  </header>
                  <p className="status-summary">{card.summary}</p>
                  <p className="status-role">{card.role}</p>
                  <dl>
                    {card.facts.map((fact) => (
                      <div key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
          </div>
        </div>
      ))}

      <h2>Workers</h2>
      <div className="table-wrap">
        <table className="admin-table" data-testid="status-workers">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Kind</th>
              <th>State</th>
              <th>Doing</th>
              <th>Engine</th>
              <th>Up since</th>
            </tr>
          </thead>
          <tbody>
            {status.workers
              .filter((w) => w.liveness !== 'stopped' || w.silentSec < 3600)
              .map((worker) => (
                <tr key={worker.id} data-testid={`status-worker-${worker.id}`}>
                  <td>
                    <strong>{worker.id}</strong>
                    <small>
                      {worker.host} · pid {worker.pid}
                    </small>
                  </td>
                  <td>{worker.kind}</td>
                  <td>
                    <span className={`pill ${pillFor(LIVENESS_HEALTH[worker.liveness])}`}>{worker.liveness}</span>
                    <small>{worker.liveness === 'alive' ? `${worker.silentSec}s ago` : `silent ${duration(worker.silentSec)}`}</small>
                  </td>
                  <td>{worker.currentJobId ? <code>{worker.currentJobId.slice(0, 8)}</code> : <small>idle</small>}</td>
                  <td>
                    <small>
                      {worker.engine ?? '—'} {worker.engineVersion ?? ''}
                    </small>
                  </td>
                  <td>
                    <small>{new Date(worker.startedAt).toLocaleString()}</small>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {status.workers.length === 0 && <p className="auth-sub">No worker has ever registered with this database.</p>}

      <h2>
        Renders in progress <small className="auth-sub">({status.render.running.length}, all organizations)</small>
      </h2>
      <RenderTable jobs={status.render.running} since={since} concernText={concernText} testId="status-running" empty="Nothing is rendering right now." />

      <h2>
        Render queue <small className="auth-sub">({status.render.queued.length} waiting)</small>
      </h2>
      <RenderTable jobs={status.render.queued} since={since} concernText={concernText} testId="status-queued" empty="The queue is empty." />
      <p className="auth-sub">
        <a className="auth-link" href="/admin/queue">
          Open the queue
        </a>{' '}
        to cancel, retry or read a job's log.
      </p>

      <h2>CAD ingestions in flight</h2>
      {status.cad.inFlight.length === 0 ? (
        <p className="auth-sub" data-testid="status-cad-empty">
          No CAD file is being ingested.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table" data-testid="status-cad">
            <thead>
              <tr>
                <th>File</th>
                <th>Organization</th>
                <th>Progress</th>
                <th>Time</th>
                <th>Worker</th>
              </tr>
            </thead>
            <tbody>
              {status.cad.inFlight.map((job) => (
                <tr key={job.id}>
                  <td>
                    <strong>{job.sourceName ?? 'unnamed'}</strong>
                    <small>{job.format.toUpperCase()}</small>
                    <Concerns concerns={job.concerns} text={concernText} />
                  </td>
                  <td>{job.orgName}</td>
                  <td>
                    <Progress status={job.status} stage={job.stage} progress={job.progress} />
                  </td>
                  <td>
                    <small>{job.startedAt ? `running ${duration(since(job.startedAt))}` : `waiting ${duration(since(job.queuedAt))}`}</small>
                  </td>
                  <td>
                    <small>{job.workerId ?? '—'}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Last 24 hours</h2>
      <Day status={status} />

      <h2>Server log</h2>
      <p className="auth-sub">
        Warnings and errors from the web app and the workers, newest first. {status.events.errorsLastHour} errors and{' '}
        {status.events.warningsLastHour} warnings in the last hour; {status.events.errorsLast24h} errors in the last day.
        Refused requests (4xx) are the client's, not the server's, and are left out.
      </p>
      <div className="status-filters">
        <label>
          Level{' '}
          <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)} data-testid="log-level">
            <option value="">Errors and warnings</option>
            <option value="error">Errors only</option>
            <option value="warn">Warnings only</option>
          </select>
        </label>
        <label>
          Service{' '}
          <select value={service} onChange={(e) => setService(e.target.value)} data-testid="log-service">
            <option value="">Every service</option>
            {status.events.services.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <EventTable events={status.events.recent} />
    </section>
  );
}

function RenderTable({
  jobs,
  since,
  concernText,
  testId,
  empty,
}: {
  jobs: LiveRender[];
  since: (iso: string | null) => number;
  concernText: Record<JobConcern, string>;
  testId: string;
  empty: string;
}) {
  if (jobs.length === 0) {
    return (
      <p className="auth-sub" data-testid={`${testId}-empty`}>
        {empty}
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table className="admin-table" data-testid={testId}>
        <thead>
          <tr>
            <th>{jobs[0]?.status === 'queued' ? '#' : 'Job'}</th>
            <th>Organization</th>
            <th>Design</th>
            <th>Progress</th>
            <th>Time</th>
            <th>Worker</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} data-testid={`${testId}-${job.id}`}>
              <td>
                <strong>{job.position !== null ? job.position : job.id.slice(0, 8)}</strong>
                {job.position !== null && <small>{job.id.slice(0, 8)}</small>}
                {job.attempts > 1 && <small>attempt {job.attempts}</small>}
                <Concerns concerns={job.concerns} text={concernText} />
              </td>
              <td>
                {job.orgName}
                <small>{job.submittedBy ?? 'unknown'}</small>
              </td>
              <td>{job.designName ?? '—'}</td>
              <td>
                <Progress status={job.status} stage={job.stage} progress={job.progress} />
              </td>
              <td>
                <small>
                  {job.startedAt
                    ? `${duration(since(job.startedAt))} of ~${duration(job.estimateSeconds)}`
                    : `waiting ${duration(since(job.queuedAt))} · ~${duration(job.estimateSeconds)} to render`}
                </small>
              </td>
              <td>
                <small>{job.workerId ?? '—'}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Day({ status }: { status: StatusPayload['status'] }) {
  const day = status.last24h;
  const finished = day.succeeded + day.failed;
  const peak = Math.max(1, ...day.hourly.map((h) => h.succeeded + h.failed));
  return (
    <>
      <div className="status-tiles" data-testid="status-day">
        <Tile label="Succeeded" value={String(day.succeeded)} />
        <Tile label="Failed" value={String(day.failed)} health={day.failed > 0 ? 'warn' : 'ok'} />
        <Tile label="Cancelled" value={String(day.canceled)} />
        <Tile label="Failure rate" value={finished === 0 ? '—' : `${Math.round((day.failed / finished) * 100)}%`} />
        <Tile label="Median render" value={day.medianSec === null ? '—' : duration(day.medianSec)} />
        <Tile label="Slowest 5%" value={day.p95Sec === null ? '—' : duration(day.p95Sec)} />
        <Tile label="Render time" value={duration(day.gpuSeconds)} />
        <Tile label="Database" value={bytes(status.database.sizeBytes)} />
      </div>
      <div className="status-chart" aria-label="Renders finished per hour" data-testid="status-hourly">
        {day.hourly.map((h) => (
          <div key={h.hour} className="status-bar" title={`${new Date(h.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${h.succeeded} succeeded, ${h.failed} failed`}>
            <span className="status-bar-failed" style={{ height: `${(h.failed / peak) * 100}%` }} />
            <span className="status-bar-ok" style={{ height: `${(h.succeeded / peak) * 100}%` }} />
          </div>
        ))}
      </div>
      <p className="auth-sub status-chart-caption">Renders finished per hour, oldest on the left. Red is failed.</p>
      <div className="status-columns">
        <div>
          <h3>Why renders failed</h3>
          {day.failuresByCode.length === 0 ? (
            <p className="auth-sub">No failures.</p>
          ) : (
            <ul className="admin-audit">
              {day.failuresByCode.map((f) => (
                <li key={f.code}>
                  <code>{f.code}</code>
                  <span>{f.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>Organizations at or near a limit</h3>
          {status.nearLimit.length === 0 ? (
            <p className="auth-sub" data-testid="status-limits-empty">
              Nobody is close to a limit.
            </p>
          ) : (
            <ul className="admin-audit" data-testid="status-limits">
              {status.nearLimit.map((org) => (
                <li key={org.orgId}>
                  <a className="auth-link" href={`/admin/orgs/${org.orgId}`}>
                    {org.orgName}
                  </a>
                  <span>
                    {org.today} of {org.perDay} today · {org.active} of {org.maxConcurrent} at once
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function EventTable({ events }: { events: ServiceEventView[] }) {
  if (events.length === 0) {
    return (
      <p className="admin-ok" data-testid="log-empty">
        Nothing logged.
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table className="admin-table status-log" data-testid="status-log">
        <thead>
          <tr>
            <th>Time</th>
            <th>Level</th>
            <th>Service</th>
            <th>What happened</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className={`log-${event.level}`} data-testid={`log-${event.id}`} data-level={event.level}>
              <td>
                <small>{new Date(event.at).toLocaleString()}</small>
              </td>
              <td>
                <span className={`pill ${event.level === 'error' ? 'bad' : 'warn'}`}>{event.level === 'error' ? 'error' : 'warning'}</span>
              </td>
              <td>
                <code>{event.service}</code>
              </td>
              <td>
                <strong>{event.message}</strong>
                {event.error && (
                  <small className="admin-error">
                    {event.error.name}: {event.error.message}
                  </small>
                )}
                {(event.error?.stack || Object.keys(event.fields).length > 0) && (
                  <details>
                    <summary>Details</summary>
                    {Object.keys(event.fields).length > 0 && <pre>{JSON.stringify(event.fields, null, 2)}</pre>}
                    {event.error?.stack && <pre>{event.error.stack}</pre>}
                  </details>
                )}
              </td>
              <td>
                <small>
                  {[
                    typeof event.fields['route'] === 'string' ? `${event.fields['method'] ?? ''} ${event.fields['path'] ?? event.fields['route']}`.trim() : null,
                    typeof event.fields['status'] === 'number' ? `→ ${event.fields['status']}` : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </small>
                {event.requestId && <small>request {event.requestId}</small>}
                {event.jobId && <small>job {event.jobId.slice(0, 8)}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Progress({ status, stage, progress }: { status: string; stage: string | null; progress: number }) {
  if (status === 'queued') return <small>waiting</small>;
  const percent = Math.round(progress * 100);
  return (
    <div className="status-progress" title={`${percent}%`}>
      <div className="status-progress-track">
        <div className="status-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <small>
        {percent}% · {stage ?? 'starting'}
      </small>
    </div>
  );
}

function Concerns({ concerns, text }: { concerns: JobConcern[]; text: Record<JobConcern, string> }) {
  return (
    <>
      {concerns.map((concern) => (
        <small key={concern} className="admin-warn" data-testid="status-concern">
          {text[concern]}
        </small>
      ))}
    </>
  );
}

function Tile({ label, value, health }: { label: string; value: string; health?: Health }) {
  return (
    <div className={`status-tile${health ? ` health-${health}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Dot({ health }: { health: Health | 'idle' }) {
  return <span className={`status-dot health-${health}`} aria-hidden />;
}

const pillFor = (health: Health | 'idle') => (health === 'ok' ? 'ok' : health === 'warn' ? 'warn' : health === 'down' ? 'bad' : '');
