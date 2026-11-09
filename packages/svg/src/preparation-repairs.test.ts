import { describe, expect, it } from 'vitest';
import { IDENTITY, parsePathData, serializePathData } from './path.js';
import { applyPreparationRepairs, preparationSubpaths } from './preparation-repairs.js';
import type { PreparationObject } from './preparation-types.js';

const object = (id: string, d: string, strokeWidth = 1): PreparationObject => ({
  id,
  label: id,
  groups: [],
  segments: parsePathData(d),
  matrix: IDENTITY,
  fill: null,
  stroke: '#000000',
  strokeWidth,
  fillRule: 'nonzero',
  linecap: 'butt',
  linejoin: 'miter',
  miterLimit: 4,
  dashArray: [],
  dashOffset: 0,
  hidden: false,
  clips: [],
  bounds: null,
});

describe('explicit preparation repairs', () => {
  it('leaves every open contour unchanged without an applied operation', () => {
    const input = [object('o1', 'M0 0H10 M0 5H10Z M0 10H10')];
    const result = applyPreparationRepairs(input, []);
    expect(result).toEqual(input);
    expect(preparationSubpaths(result[0]!).map((path) => path.closed)).toEqual([
      false,
      true,
      false,
    ]);
  });
  it('closes only the explicitly chosen contour and preserves the original', () => {
    const input = [object('o1', 'M0 0H10 M0 5H10')];
    const result = applyPreparationRepairs(input, [
      { kind: 'close', objectId: 'o1', subpathId: 'o1:s1' },
    ]);
    expect(preparationSubpaths(result[0]!).map((path) => path.closed)).toEqual([false, true]);
    expect(preparationSubpaths(input[0]!).map((path) => path.closed)).toEqual([false, false]);
  });
  it('reverses cubic control points when joining two chosen start endpoints', () => {
    const input = [object('a', 'M0 0C1 2 3 4 5 6'), object('b', 'M-5 0L-10 0')];
    const result = applyPreparationRepairs(input, [
      {
        kind: 'join',
        a: { objectId: 'a', subpathId: 'a:s0', end: 'start' },
        b: { objectId: 'b', subpathId: 'b:s0', end: 'start' },
      },
    ]);
    expect(serializePathData(result[0]!.segments)).toBe('M5 6 C3 4 1 2 0 0 L-5 0 L-10 0');
    expect(result[1]!.segments).toEqual([]);
    expect(preparationSubpaths(result[0]!)[0]!.closed).toBe(false);
  });
  it('rejects incompatible and already-closed endpoints instead of guessing', () => {
    const input = [object('a', 'M0 0H10'), object('b', 'M12 0H20', 2)];
    const join = {
      kind: 'join' as const,
      a: { objectId: 'a', subpathId: 'a:s0', end: 'end' as const },
      b: { objectId: 'b', subpathId: 'b:s0', end: 'start' as const },
    };
    expect(() => applyPreparationRepairs(input, [join])).toThrow('incompatible');
    expect(() =>
      applyPreparationRepairs(
        [object('a', 'M0 0H10Z')],
        [{ kind: 'close', objectId: 'a', subpathId: 'a:s0' }],
      ),
    ).toThrow('already closed');
  });
  it('keeps source subpath IDs stable after joining an earlier sibling', () => {
    const input = [object('a', 'M0 0H5 M10 0H15 M20 0H25')];
    const result = applyPreparationRepairs(input, [
      {
        kind: 'join',
        a: { objectId: 'a', subpathId: 'a:s1', end: 'start' },
        b: { objectId: 'a', subpathId: 'a:s0', end: 'end' },
      },
      { kind: 'close', objectId: 'a', subpathId: 'a:s2' },
    ]);
    expect(preparationSubpaths(result[0]!).map((path) => [path.id, path.closed])).toEqual([
      ['a:s1', false],
      ['a:s2', true],
    ]);
    expect(serializePathData(result[0]!.segments)).toBe('M15 0 L10 0 L5 0 L0 0 M20 0 L25 0 Z');
  });
  it('joins in physical coordinates without moving either original endpoint', () => {
    const a = object('a', 'M0 0H5');
    const b = object('b', 'M0 0H5');
    a.matrix = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 0 };
    b.matrix = { a: 0, b: 1, c: -1, d: 0, e: 25, f: 0 };
    b.strokeWidth = 2;
    const result = applyPreparationRepairs(
      [a, b],
      [
        {
          kind: 'join',
          a: { objectId: 'a', subpathId: 'a:s0', end: 'end' },
          b: { objectId: 'b', subpathId: 'b:s0', end: 'start' },
        },
      ],
    );
    const path = preparationSubpaths(result[0]!)[0]!;
    expect(path.start).toEqual([10, 0]);
    expect(path.end).toEqual([25, 5]);
    expect(serializePathData(path.segments)).toBe('M0 0 L5 0 L7.5 0 L7.5 2.5');
  });
  it('does not treat coincident endpoints as a source closure', () => {
    const input = [object('a', 'M0 0H5L0 0')];
    const unchanged = preparationSubpaths(applyPreparationRepairs(input, [])[0]!)[0]!;
    expect(unchanged.start).toEqual(unchanged.end);
    expect(unchanged.closed).toBe(false);
    expect(
      preparationSubpaths(
        applyPreparationRepairs(input, [{ kind: 'close', objectId: 'a', subpathId: 'a:s0' }])[0]!,
      )[0]!.closed,
    ).toBe(true);
  });
  it('sets physical stroke width only explicitly and refuses ambiguous nonuniform repair', () => {
    const a = object('a', 'M0 0H5');
    a.stroke = null;
    a.matrix = { ...IDENTITY, a: 2, d: 2 };
    const result = applyPreparationRepairs(
      [a],
      [{ kind: 'stroke-width', objectId: 'a', widthMm: 0.8 }],
    );
    expect(result[0]!.strokeWidth).toBe(0.4);
    expect(result[0]!.stroke).toBe('#000000');
    expect(a.stroke).toBeNull();
    a.matrix.d = 1;
    expect(() =>
      applyPreparationRepairs([a], [{ kind: 'stroke-width', objectId: 'a', widthMm: 0.8 }]),
    ).toThrow('uniform scale');
  });
});
