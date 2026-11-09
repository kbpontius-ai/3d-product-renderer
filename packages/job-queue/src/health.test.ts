import { describe, expect, it } from 'vitest';
import { jobConcerns, workerLiveness, type JobHealthInput, type WorkerLiveness } from './health.js';
import { toLine } from './workers.js';

const NOW = new Date('2026-09-29T12:00:00Z');
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);
const ahead = (sec: number) => new Date(NOW.getTime() + sec * 1000);

describe('worker liveness', () => {
  it('reads alive, stale and gone from how long it has been silent', () => {
    expect(workerLiveness({ lastSeenAt: ago(5), stoppedAt: null }, NOW)).toBe('alive');
    expect(workerLiveness({ lastSeenAt: ago(30), stoppedAt: null }, NOW)).toBe('alive');
    expect(workerLiveness({ lastSeenAt: ago(31), stoppedAt: null }, NOW)).toBe('stale');
    expect(workerLiveness({ lastSeenAt: ago(301), stoppedAt: null }, NOW)).toBe('gone');
  });

  it('tells a clean stop from a disappearance', () => {
    expect(workerLiveness({ lastSeenAt: ago(3600), stoppedAt: ago(3600) }, NOW)).toBe('stopped');
  });
});

describe('stuck jobs', () => {
  const running = (over: Partial<JobHealthInput> = {}): JobHealthInput => ({
    status: 'running',
    queuedAt: ago(60),
    startedAt: ago(50),
    leaseExpiresAt: ahead(60),
    workerId: 'w1',
    estimateSeconds: 30,
    ...over,
  });
  const workers = (liveness: WorkerLiveness) => new Map([['w1', liveness]]);

  it('finds nothing wrong with a job whose worker is reporting in', () => {
    expect(jobConcerns(running(), workers('alive'), 1, NOW)).toEqual([]);
  });

  it('flags the audit case at once: the worker died, the lease has not lapsed yet', () => {
    // Killed mid-render, the job still showed "running" for two minutes. The worker's silence is
    // visible after thirty seconds, well before the lease gives up.
    expect(jobConcerns(running(), workers('stale'), 0, NOW)).toEqual(['worker_silent']);
    expect(jobConcerns(running(), new Map(), 0, NOW)).toEqual(['worker_silent']);
  });

  it('flags a lapsed lease', () => {
    expect(jobConcerns(running({ leaseExpiresAt: ago(1) }), workers('gone'), 0, NOW)).toEqual([
      'lease_lapsed',
      'worker_silent',
    ]);
  });

  it('calls a job overdue only well past its estimate', () => {
    expect(jobConcerns(running({ startedAt: ago(600) }), workers('alive'), 1, NOW)).toEqual([]);
    expect(jobConcerns(running({ startedAt: ago(901) }), workers('alive'), 1, NOW)).toEqual(['overdue']);
    expect(jobConcerns(running({ startedAt: ago(1500), estimateSeconds: 400 }), workers('alive'), 1, NOW)).toEqual([]);
  });

  it('flags a queued job nobody can pick up, and one waiting too long', () => {
    const queued = running({ status: 'queued', startedAt: null, leaseExpiresAt: null, workerId: null });
    expect(jobConcerns(queued, new Map(), 1, NOW)).toEqual([]);
    expect(jobConcerns(queued, new Map(), 0, NOW)).toEqual(['no_worker']);
    expect(jobConcerns({ ...queued, queuedAt: ago(601) }, new Map(), 1, NOW)).toEqual(['waiting_long']);
  });

  it('has nothing to say about finished jobs', () => {
    for (const status of ['succeeded', 'failed', 'canceled'] as const) {
      expect(jobConcerns(running({ status, leaseExpiresAt: ago(999) }), new Map(), 0, NOW)).toEqual([]);
    }
  });
});

describe('a job log line', () => {
  it('drops the ids every line of the job already has, and shortens payloads', () => {
    const line = toLine({
      time: NOW.toISOString(),
      level: 'info',
      message: 'render finished',
      fields: { workerId: 'w1', jobId: 'j', orgId: 'o', requestId: 'r', seconds: 12.5, blob: 'x'.repeat(2000) },
    });
    expect(line.fields?.['seconds']).toBe(12.5);
    expect(Object.keys(line.fields ?? {})).toEqual(['seconds', 'blob']);
    expect(String(line.fields?.['blob']).length).toBeLessThan(510);
  });

  it('keeps the error that ended a job', () => {
    const line = toLine({
      time: NOW.toISOString(),
      level: 'error',
      message: 'job threw',
      fields: {},
      error: { name: 'Error', message: 'blender exited 139' },
    });
    expect(line).toMatchObject({ level: 'error', fields: { error: 'Error: blender exited 139' } });
  });
});
