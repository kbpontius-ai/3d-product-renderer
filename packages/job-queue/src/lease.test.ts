import { describe, expect, it } from 'vitest';
import { QueueError, queueTable } from './lease.js';

describe('queueTable', () => {
  it('accepts the names the queues actually use', () => {
    expect(queueTable('render_jobs')).toBe('render_jobs');
    expect(queueTable('cad_jobs')).toBe('cad_jobs');
  });

  it('refuses anything that is not a plain identifier', () => {
    // `sql(name)` quotes an identifier properly, so this is not what stands between the queue and
    // an injection. It is what makes the one place a string becomes SQL structure rather than a
    // SQL value explicit, and it turns a typo into a clear error instead of a puzzling one.
    for (const bad of ['render jobs', 'render_jobs; drop table users', 'public.render_jobs', '', '1_jobs', 'Render_Jobs']) {
      expect(() => queueTable(bad)).toThrow(/queue table name/);
    }
  });
});

describe('QueueError', () => {
  it('carries a code an API layer can map to a status without reading the message', () => {
    const error = new QueueError('quota_exceeded', 'Daily limit reached.', { used: 50, limit: 50 });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('QueueError');
    expect(error.code).toBe('quota_exceeded');
    expect(error.detail).toEqual({ used: 50, limit: 50 });
  });

  it('falls back to the code when there is nothing better to say', () => {
    expect(new QueueError('not_found').message).toBe('not_found');
  });
});
