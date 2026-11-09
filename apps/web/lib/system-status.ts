import type { SystemStatus } from '@pr/admin/status';

/**
 * Turning raw status into a verdict per service (the System Status page, F-ADM-15).
 *
 * Pure, so the rules that decide whether something shows green, amber or red are written down and
 * tested in one place rather than scattered through the page's markup.
 */

export type Health = 'ok' | 'warn' | 'down';

export interface ServiceCard {
  key: string;
  name: string;
  /** What it powers, for someone who did not build it. */
  role: string;
  group: 'Serving' | 'Data' | 'Processing' | 'Delivery';
  health: Health;
  summary: string;
  facts: { label: string; value: string }[];
}

export type EmailMode = 'resend' | 'dev_mailbox' | 'misconfigured' | 'none';

export interface StatusChecks {
  status: SystemStatus;
  storage: { ok: boolean; latencyMs: number };
  email: { mode: EmailMode; sender: string | null; failures24h: number };
  web: { uptimeSec: number; node: string; environment: string };
}

/** Slower than this for `select 1` and the database is struggling. */
const SLOW_DB_MS = 250;
/** A queue whose oldest job has waited this long needs more workers, or working ones. */
const SLOW_QUEUE_SEC = 600;

export function serviceCards({ status, storage, email, web }: StatusChecks): ServiceCard[] {
  const workersOf = (kind: 'render' | 'cad') => status.workers.filter((w) => w.kind === kind);
  const renderWorkers = workersOf('render');
  const cadWorkers = workersOf('cad');
  const alive = (list: typeof renderWorkers) => list.filter((w) => w.liveness === 'alive');
  const renderConcerns = [...status.render.running, ...status.render.queued].filter((j) => j.concerns.length > 0);
  const cadConcerns = status.cad.inFlight.filter((j) => j.concerns.length > 0);
  const cadQueued = status.cad.counts.queued;

  return [
    {
      key: 'web',
      name: 'Web app',
      role: 'Every page and API request: sign-in, the catalog, the editor, the admin console.',
      group: 'Serving',
      // It answered this request, so it is up; errors say whether it is well.
      health: status.events.errorsLastHour > 0 ? 'warn' : 'ok',
      summary:
        status.events.errorsLastHour > 0
          ? `${plural(status.events.errorsLastHour, 'server error')} in the last hour`
          : 'Serving requests',
      facts: [
        { label: 'Up for', value: duration(web.uptimeSec) },
        { label: 'Node', value: web.node },
        { label: 'Mode', value: web.environment },
      ],
    },
    {
      key: 'database',
      name: 'Database',
      role: 'PostgreSQL: accounts, designs, packs, and both job queues.',
      group: 'Data',
      health: status.database.latencyMs > SLOW_DB_MS ? 'warn' : 'ok',
      summary: status.database.latencyMs > SLOW_DB_MS ? 'Responding slowly' : 'Responding',
      facts: [
        { label: 'Round trip', value: `${status.database.latencyMs} ms` },
        { label: 'Size', value: bytes(status.database.sizeBytes) },
        { label: 'Connections', value: String(status.database.connections) },
        { label: 'Schema', value: status.database.migration?.replace(/\.sql$/, '') ?? 'none' },
      ],
    },
    {
      key: 'storage',
      name: 'Object storage',
      role: 'Pack meshes, uploaded artwork, CAD sources and finished renders.',
      group: 'Data',
      health: storage.ok ? 'ok' : 'down',
      summary: storage.ok ? 'Reachable' : 'Unreachable: meshes, artwork and renders cannot be served',
      facts: [{ label: 'Check', value: `${storage.latencyMs} ms` }],
    },
    workerCard('render', renderWorkers, status.render.counts.queued, renderConcerns.length),
    workerCard('cad', cadWorkers, cadQueued, cadConcerns.length),
    {
      key: 'render-queue',
      name: 'Render queue',
      role: 'Renders waiting for, or being worked on by, a render worker.',
      group: 'Processing',
      health:
        renderConcerns.length > 0 || (status.render.oldestQueuedSec ?? 0) > SLOW_QUEUE_SEC ? 'warn' : 'ok',
      summary:
        renderConcerns.length > 0
          ? `${plural(renderConcerns.length, 'job')} need attention`
          : `${status.render.counts.running} running · ${status.render.counts.queued} waiting`,
      facts: [
        { label: 'Oldest waiting', value: status.render.oldestQueuedSec === null ? '—' : duration(status.render.oldestQueuedSec) },
        { label: 'Failed (24 h)', value: String(status.last24h.failed) },
      ],
    },
    {
      key: 'cad-queue',
      name: 'CAD queue',
      role: 'STEP files waiting to be turned into draft packs.',
      group: 'Processing',
      health: cadConcerns.length > 0 ? 'warn' : 'ok',
      summary:
        cadConcerns.length > 0
          ? `${plural(cadConcerns.length, 'ingestion')} need attention`
          : `${status.cad.counts.running} running · ${cadQueued} waiting`,
      facts: [{ label: 'Failed (all time)', value: String(status.cad.counts.failed) }],
    },
    emailCard(email),
  ];

  function workerCard(
    kind: 'render' | 'cad',
    list: typeof renderWorkers,
    queued: number,
    concerns: number,
  ): ServiceCard {
    const live = alive(list);
    const silent = list.filter((w) => w.liveness === 'stale' || w.liveness === 'gone');
    const busy = live.filter((w) => w.currentJobId).length;
    const name = kind === 'render' ? 'Render workers' : 'CAD workers';
    const noun = kind === 'render' ? 'renders' : 'ingestions';

    let health: Health = 'ok';
    let summary = `${plural(live.length, 'worker')} alive · ${busy} busy`;
    if (live.length === 0) {
      // None running is an outage only when there is work for them; otherwise it is a warning.
      health = queued > 0 ? 'down' : 'warn';
      summary = queued > 0 ? `None running: ${plural(queued, 'job')} waiting` : `None running: new ${noun} will wait`;
    } else if (silent.length > 0 || concerns > 0) {
      health = 'warn';
      summary = silent.length > 0 ? `${plural(silent.length, 'worker')} stopped reporting` : summary;
    }

    const engines = [...new Set(live.map((w) => `${w.engine ?? '?'} ${w.engineVersion ?? ''}`.trim()))];
    return {
      key: `${kind}-workers`,
      name,
      role:
        kind === 'render'
          ? 'Blender Cycles path tracing: turns a design into final images.'
          : 'OpenCASCADE: turns a STEP file into meshes and a draft pack.',
      group: 'Processing',
      health,
      summary,
      facts: [
        { label: 'Alive', value: `${live.length} of ${list.filter((w) => w.liveness !== 'stopped').length}` },
        { label: 'Engine', value: engines.join(', ') || '—' },
      ],
    };
  }
}

function emailCard(email: StatusChecks['email']): ServiceCard {
  const base = {
    key: 'email',
    name: 'Email',
    role: 'Invitations, password resets and render notifications.',
    group: 'Delivery' as const,
  };
  const facts = [
    { label: 'Provider', value: email.mode === 'resend' ? 'Resend' : email.mode === 'dev_mailbox' ? 'Development mailbox' : 'None' },
    ...(email.sender ? [{ label: 'Sends as', value: email.sender }] : []),
    { label: 'Failed sends (24 h)', value: String(email.failures24h) },
  ];

  if (email.mode === 'misconfigured') {
    return { ...base, health: 'down', summary: 'A provider key is set but no sender: nothing is sent', facts };
  }
  if (email.mode === 'none') {
    return { ...base, health: 'warn', summary: 'No provider: invitations and resets are not emailed', facts };
  }
  if (email.failures24h > 0) {
    return { ...base, health: 'warn', summary: `${plural(email.failures24h, 'send')} failed in the last day`, facts };
  }
  return {
    ...base,
    health: 'ok',
    summary: email.mode === 'dev_mailbox' ? 'Kept on this machine; nothing leaves it' : 'Sending',
    facts,
  };
}

export type Overall = 'operational' | 'degraded' | 'outage';

export function overall(cards: ServiceCard[]): Overall {
  if (cards.some((c) => c.health === 'down')) return 'outage';
  if (cards.some((c) => c.health === 'warn')) return 'degraded';
  return 'operational';
}

/**
 * Whether a logged problem belongs in the service event log.
 *
 * A 4xx is the client being told no — a wrong password, a missing page — which `route()` already
 * logs as a warning and is not the server's fault; recording each one would bury the errors this
 * log exists to show.
 */
export function reportable(level: 'warn' | 'error', fields: Record<string, unknown>): boolean {
  const status = fields['status'];
  return !(level === 'warn' && typeof status === 'number' && status < 500);
}

export function duration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3600)}h`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
