import { describe, expect, it } from 'vitest';
import { resolveDecorationTarget } from './decoration-target.js';

describe('decoration target', () => {
  it('preserves historical generic GLB material mappings', () => {
    expect(resolveDecorationTarget(undefined, 'body', ['cap-body'], ['body'])).toBe('body');
  });
  it('uses the actual cap when the historical first slot is an empty assembly', () => {
    expect(resolveDecorationTarget(undefined, 'assembly', ['cap'])).toBe('cap');
  });
  it('preserves a drawable legacy target in multipart products', () => {
    expect(resolveDecorationTarget(undefined, 'body', ['body', 'lid'])).toBe('body');
  });
  it('honors explicit targets on multipart products', () => {
    expect(resolveDecorationTarget('lid', 'body', ['body', 'lid'])).toBe('lid');
  });
  it('deduplicates primitives belonging to the same physical target', () => {
    expect(resolveDecorationTarget(undefined, 'empty', ['cap', 'cap'])).toBe('cap');
  });
  it('requires a decision when a legacy target has several possible replacements', () => {
    expect(() => resolveDecorationTarget(undefined, 'empty', ['body', 'lid'])).toThrow('Choose');
  });
  it('rejects stale explicit targets rather than moving the artwork', () => {
    expect(() => resolveDecorationTarget('missing', 'body', ['body'])).toThrow('no drawable');
    expect(() => resolveDecorationTarget(undefined, 'body', [])).toThrow('Choose');
  });
});
