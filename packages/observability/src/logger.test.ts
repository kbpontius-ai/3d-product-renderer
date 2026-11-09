import { describe, expect, it, vi } from 'vitest';
import { Logger, redact, setErrorReporter, type LogRecord } from './logger.js';
import { increment, measure, observe, resetMetrics, snapshot } from './metrics.js';
import { currentLog, enrichLogContext, withLogContext } from './context.js';

/**
 * What matters about a logger is that the record can be found later, and that it never carries
 * something it should not.
 */

function capture(): { records: LogRecord[]; logger: Logger } {
  const records: LogRecord[] = [];
  const logger = new Logger({
    level: 'debug',
    sink: (record) => records.push(record),
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  return { records, logger };
}

describe('Logger', () => {
  it('writes one structured record per event', () => {
    const { records, logger } = capture();
    logger.info('render finished', { jobId: 'j1', ms: 41_000 });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      message: 'render finished',
      fields: { jobId: 'j1', ms: 41_000 },
      time: '2026-01-01T00:00:00.000Z',
    });
  });

  it('carries bound fields onto every record', () => {
    const { records, logger } = capture();
    const request = logger.child({ requestId: 'r1', orgId: 'o1' });

    request.info('first');
    request.warn('second', { designId: 'd1' });

    expect(records[0]?.fields).toEqual({ requestId: 'r1', orgId: 'o1' });
    expect(records[1]?.fields).toEqual({ requestId: 'r1', orgId: 'o1', designId: 'd1' });
  });

  it('drops records below the configured level', () => {
    const records: LogRecord[] = [];
    const logger = new Logger({ level: 'warn', sink: (r) => records.push(r) });

    logger.debug('noise');
    logger.info('also noise');
    logger.error('this one matters');

    expect(records.map((r) => r.level)).toEqual(['error']);
  });

  it('flattens an error, which JSON would otherwise discard', () => {
    const { records, logger } = capture();
    logger.error('bake failed', new TypeError('no such zone'));

    expect(records[0]?.error).toMatchObject({ name: 'TypeError', message: 'no such zone' });
    expect(JSON.parse(JSON.stringify(records[0]))).toHaveProperty('error.message', 'no such zone');
  });

  it('times an operation and records how it ended', async () => {
    const { records, logger } = capture();
    await logger.time('bake', async () => 'done', { jobId: 'j1' });

    expect(records[0]?.fields).toMatchObject({ jobId: 'j1', outcome: 'ok' });
    expect(records[0]?.fields['ms']).toBeTypeOf('number');
  });

  it('logs a failure and still lets it through', async () => {
    const { records, logger } = capture();
    await expect(
      logger.time('bake', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    expect(records[0]).toMatchObject({ level: 'error', fields: { outcome: 'error' } });
  });

  it('reports errors to whatever is watching for them', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    try {
      const { logger } = capture();
      logger.child({ orgId: 'o1' }).error('boom', new Error('bad'));
      expect(reporter).toHaveBeenCalledOnce();
      expect(reporter.mock.calls[0]?.[1]).toMatchObject({ orgId: 'o1', message: 'boom' });
      expect(reporter.mock.calls[0]?.[2]).toBe('error');
    } finally {
      setErrorReporter(null);
    }
  });

  it('reports warnings too, redacted, and never info', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    try {
      const { logger } = capture();
      logger.info('fine');
      logger.warn('swept stale jobs', { requeued: 1, resetToken: 'abc' });
      expect(reporter).toHaveBeenCalledOnce();
      expect(reporter.mock.calls[0]).toEqual([
        undefined,
        { requeued: 1, resetToken: '[redacted]', message: 'swept stale jobs' },
        'warn',
      ]);
    } finally {
      setErrorReporter(null);
    }
  });

  it('tees records to a second sink without losing the first', () => {
    const { records, logger } = capture();
    const teed: LogRecord[] = [];
    const jobLog = logger.child({ jobId: 'j1' }).tee((record) => teed.push(record));
    jobLog.info('job claimed');
    jobLog.child({ attempt: 2 }).warn('slow');

    expect(records.map((r) => r.message)).toEqual(['job claimed', 'slow']);
    expect(teed.map((r) => r.message)).toEqual(['job claimed', 'slow']);
    expect(teed[1]?.fields).toEqual({ jobId: 'j1', attempt: 2 });
  });
});

describe('redact', () => {
  it('removes anything that looks like a credential, however it is nested', () => {
    const safe = redact({
      email: 'a@example.com',
      token: 'secret-value',
      nested: { resetToken: 'another', count: 2 },
      list: [1, 2],
    });

    expect(safe).toEqual({
      email: 'a@example.com',
      token: '[redacted]',
      nested: { resetToken: '[redacted]', count: 2 },
      list: [1, 2],
    });
  });

  it('keeps an Error readable rather than serialising it to {}', () => {
    expect(redact({ cause: new Error('why') })).toEqual({ cause: 'why' });
  });
});

describe('metrics', () => {
  it('counts and times, and reports a mean', async () => {
    resetMetrics();
    increment('render.started');
    increment('render.started');
    observe('render.bake', 100);
    observe('render.bake', 300);
    await measure('render.trace', async () => undefined);

    const taken = snapshot();
    expect(taken.counters['render.started']).toBe(2);
    expect(taken.timings['render.bake']).toMatchObject({ count: 2, totalMs: 400, meanMs: 200, maxMs: 300 });
    expect(taken.timings['render.trace']?.count).toBe(1);
  });

  it('records a timing even when the operation throws', async () => {
    resetMetrics();
    await expect(
      measure('render.trace', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow();

    expect(snapshot().timings['render.trace']?.count).toBe(1);
  });
});

describe('log context', () => {
  it('keeps the request id attached across awaits, and learns the org partway through', async () => {
    const records: LogRecord[] = [];
    const base = new Logger({ level: 'debug', sink: (r) => records.push(r) });

    await withLogContext(base.child({ requestId: 'r1' }), async () => {
      currentLog().info('before');
      await Promise.resolve();
      enrichLogContext({ orgId: 'o1' });
      await new Promise((resolve) => setTimeout(resolve, 1));
      currentLog().info('after');
    });

    expect(records[0]?.fields).toEqual({ requestId: 'r1' });
    expect(records[1]?.fields).toEqual({ requestId: 'r1', orgId: 'o1' });
  });

  it('falls back to the process logger outside a request', () => {
    expect(currentLog()).toBeInstanceOf(Logger);
  });
});
