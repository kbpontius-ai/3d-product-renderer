import { describe, expect, it } from 'vitest';
import type { SystemStatus, WorkerView } from '@pr/admin/status';
import { bytes, duration, overall, reportable, serviceCards, type StatusChecks } from './system-status';

/** The rules that decide green, amber and red on the System Status page. */

const counts = (over: Partial<SystemStatus['render']['counts']> = {}) => ({
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
  ...over,
});

const worker = (kind: 'render' | 'cad', liveness: WorkerView['liveness'], id = `${kind}-${liveness}`): WorkerView => ({
  id,
  kind,
  host: 'host',
  pid: 1,
  engine: kind === 'render' ? 'cycles-local' : 'occt',
  engineVersion: '4.2',
  startedAt: '2026-09-29T00:00:00Z',
  lastSeenAt: '2026-09-29T00:00:00Z',
  silentSec: liveness === 'alive' ? 3 : 400,
  liveness,
  currentJobId: null,
});

function checks(over: { status?: Partial<SystemStatus>; email?: Partial<StatusChecks['email']>; storageOk?: boolean } = {}): StatusChecks {
  const status: SystemStatus = {
    now: '2026-09-29T12:00:00Z',
    database: { latencyMs: 2, sizeBytes: 50_000_000, connections: 5, migration: '0011_operations.sql' },
    workers: [worker('render', 'alive'), worker('cad', 'alive')],
    render: { counts: counts(), oldestQueuedSec: null, running: [], queued: [] },
    cad: { counts: counts(), inFlight: [] },
    last24h: { succeeded: 0, failed: 0, canceled: 0, medianSec: null, p95Sec: null, gpuSeconds: 0, failuresByCode: [], hourly: [] },
    nearLimit: [],
    events: { recent: [], errorsLastHour: 0, warningsLastHour: 0, errorsLast24h: 0, mailFailures24h: 0, services: [] },
    ...over.status,
  };
  return {
    status,
    storage: { ok: over.storageOk ?? true, latencyMs: 1 },
    email: { mode: 'resend', sender: 'Renders <no-reply@example.test>', failures24h: 0, ...over.email },
    web: { uptimeSec: 100, node: 'v26', environment: 'production build' },
  };
}

const card = (input: StatusChecks, key: string) => serviceCards(input).find((c) => c.key === key)!;

describe('service cards', () => {
  it('names every service the app runs on, all green when all is well', () => {
    const cards = serviceCards(checks());
    expect(cards.map((c) => c.key)).toEqual([
      'web',
      'database',
      'storage',
      'render-workers',
      'cad-workers',
      'render-queue',
      'cad-queue',
      'email',
    ]);
    expect(cards.every((c) => c.health === 'ok')).toBe(true);
    expect(overall(cards)).toBe('operational');
  });

  it('calls no render worker an outage only when renders are waiting for one', () => {
    const idle = checks({ status: { workers: [worker('cad', 'alive')] } });
    expect(card(idle, 'render-workers').health).toBe('warn');

    const waiting = checks({
      status: { workers: [worker('cad', 'alive')], render: { counts: counts({ queued: 2 }), oldestQueuedSec: 30, running: [], queued: [] } },
    });
    expect(card(waiting, 'render-workers')).toMatchObject({ health: 'down', summary: 'None running: 2 jobs waiting' });
    expect(overall(serviceCards(waiting))).toBe('outage');
  });

  it('flags a worker that stopped reporting, the audit case', () => {
    const input = checks({ status: { workers: [worker('render', 'alive'), worker('render', 'stale'), worker('cad', 'alive')] } });
    expect(card(input, 'render-workers')).toMatchObject({ health: 'warn', summary: '1 worker stopped reporting' });
  });

  it('turns the web card amber when the server has been failing', () => {
    const input = checks({
      status: { events: { recent: [], errorsLastHour: 3, warningsLastHour: 0, errorsLast24h: 3, mailFailures24h: 0, services: ['web'] } },
    });
    expect(card(input, 'web')).toMatchObject({ health: 'warn', summary: '3 server errors in the last hour' });
  });

  it('marks unreachable storage down', () => {
    expect(card(checks({ storageOk: false }), 'storage').health).toBe('down');
  });

  it('says plainly when email is not being sent, and why', () => {
    expect(card(checks({ email: { mode: 'none', sender: null } }), 'email').health).toBe('warn');
    expect(card(checks({ email: { mode: 'misconfigured', sender: null } }), 'email').health).toBe('down');
    expect(card(checks({ email: { mode: 'dev_mailbox', sender: null } }), 'email')).toMatchObject({
      health: 'ok',
      summary: 'Kept on this machine; nothing leaves it',
    });
    expect(card(checks({ email: { failures24h: 2 } }), 'email')).toMatchObject({ health: 'warn', summary: '2 sends failed in the last day' });
  });

  it('never shows the provider key, only the sender', () => {
    const facts = card(checks(), 'email').facts.map((f) => f.value).join(' ');
    expect(facts).toContain('no-reply@example.test');
    expect(facts).not.toMatch(/re_|key/i);
  });
});

describe('what reaches the server log', () => {
  it('keeps errors and server-side warnings, and leaves out refused requests', () => {
    expect(reportable('error', { status: 500 })).toBe(true);
    expect(reportable('warn', { message: 'swept stale jobs' })).toBe(true);
    expect(reportable('warn', { message: 'request refused', status: 404 })).toBe(false);
    expect(reportable('warn', { message: 'request refused', status: 401 })).toBe(false);
  });
});

describe('formatting', () => {
  it('reads durations and sizes the way a person would say them', () => {
    expect(duration(42)).toBe('42s');
    expect(duration(125)).toBe('2m 5s');
    expect(duration(3 * 3600 + 120)).toBe('3h 2m');
    expect(duration(2 * 86_400 + 3600)).toBe('2d 1h');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(50_000_000)).toBe('48 MB');
    expect(bytes(1536)).toBe('1.5 KB');
  });
});
