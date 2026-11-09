import { describe, expect, it } from 'vitest';
import { serviceEventRecorder, type ServiceEvent, type ServiceEventStore } from './service-events.js';

/** The recorder must never become the problem it records: batched, bounded, and quiet when it fails. */

function memoryStore(fail = false) {
  const written: ServiceEvent[][] = [];
  let prunes = 0;
  const store: ServiceEventStore = {
    write: async (events) => {
      if (fail) throw new Error('database unreachable');
      written.push(events);
    },
    prune: async () => {
      prunes += 1;
    },
  };
  return { store, written, prunes: () => prunes };
}

describe('service event recorder', () => {
  it('writes what the logger reported, in one batch, with the ids pulled out', async () => {
    const { store, written } = memoryStore();
    const recorder = serviceEventRecorder('web', store, { flushMs: 60_000 });

    recorder.report(new Error('boom'), { message: 'request failed', requestId: 'r1', route: 'renders', status: 500 }, 'error');
    recorder.report(undefined, { message: 'swept stale jobs', jobId: 'j1', requeued: 1 }, 'warn');
    await recorder.stop();

    expect(written).toHaveLength(1);
    const [failed, swept] = written[0]!;
    expect(failed).toMatchObject({
      service: 'web',
      level: 'error',
      message: 'request failed',
      requestId: 'r1',
      fields: { route: 'renders', status: 500 },
      error: { name: 'Error', message: 'boom' },
    });
    expect(swept).toMatchObject({ level: 'warn', jobId: 'j1', requestId: null, error: null, fields: { requeued: 1 } });
  });

  it('bounds its buffer, and says how much it dropped', async () => {
    const { store, written } = memoryStore();
    const recorder = serviceEventRecorder('worker-render', store, { flushMs: 60_000, maxBuffer: 3 });

    for (let i = 0; i < 10; i += 1) recorder.report(undefined, { message: `loop ${i}` }, 'error');
    await recorder.stop();

    const messages = written[0]!.map((e) => e.message);
    expect(messages.slice(0, 3)).toEqual(['loop 0', 'loop 1', 'loop 2']);
    expect(messages[3]).toMatch(/dropped 7 events/);
  });

  it('complains once, not through the logger, when it cannot write, and carries on', async () => {
    const { store } = memoryStore(true);
    const complaints: string[] = [];
    const recorder = serviceEventRecorder('web', store, { flushMs: 60_000, complain: (l) => complaints.push(l) });

    recorder.report(undefined, { message: 'a' }, 'warn');
    await recorder.flush();
    recorder.report(undefined, { message: 'b' }, 'warn');
    await recorder.flush();
    await recorder.stop();

    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toMatch(/database unreachable/);
  });

  it('prunes old rows now and then, not on every write', async () => {
    let clock = 0;
    const { store, prunes } = memoryStore();
    const recorder = serviceEventRecorder('web', store, {
      flushMs: 60_000,
      pruneEveryMs: 1000,
      now: () => new Date(clock),
    });

    clock = 5000;
    recorder.report(undefined, { message: 'a' }, 'warn');
    await recorder.flush();
    recorder.report(undefined, { message: 'b' }, 'warn');
    await recorder.flush();
    expect(prunes()).toBe(1);

    clock = 7000;
    recorder.report(undefined, { message: 'c' }, 'warn');
    await recorder.stop();
    expect(prunes()).toBe(2);
  });
});
