import { describe, expect, it } from 'vitest';
import {
  applyMatrix,
  countNodes,
  isClosed,
  matrixScale,
  multiply,
  parsePathData,
  parseTransform,
  pathBBox,
  serializePathData,
  transformSegments,
  IDENTITY,
} from './path.js';

const bbox = (d: string) => pathBBox(parsePathData(d))!;

describe('parsePathData', () => {
  it('reads absolute move and line commands', () => {
    expect(parsePathData('M1 2L3 4')).toEqual([
      { command: 'M', values: [1, 2] },
      { command: 'L', values: [3, 4] },
    ]);
  });

  it('resolves relative commands against the current point', () => {
    expect(parsePathData('m1 1l2 2')).toEqual([
      { command: 'M', values: [1, 1] },
      { command: 'L', values: [3, 3] },
    ]);
  });

  it('treats extra coordinate pairs after a moveto as linetos', () => {
    expect(parsePathData('M0 0 1 1 2 2')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [1, 1] },
      { command: 'L', values: [2, 2] },
    ]);
  });

  it('expands horizontal and vertical shorthands', () => {
    expect(parsePathData('M0 0H5V5')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [5, 0] },
      { command: 'L', values: [5, 5] },
    ]);
  });

  it('converts quadratics to cubics', () => {
    const [, curve] = parsePathData('M0 0Q10 0 10 10');
    expect(curve!.command).toBe('C');
    expect(curve!.values).toHaveLength(6);
    // Control points sit two thirds of the way toward the quadratic control point.
    expect(curve!.values[0]).toBeCloseTo(6.6667, 3);
  });

  it('reflects control points for S and T', () => {
    const smooth = parsePathData('M0 0C1 0 2 1 3 1S5 2 6 2');
    expect(smooth[2]!.command).toBe('C');
    expect(smooth[2]!.values[0]).toBeCloseTo(4, 6); // 2*3 - 2
    expect(smooth[2]!.values[1]).toBeCloseTo(1, 6);
  });

  it('closes subpaths and returns to their start', () => {
    const closed = parsePathData('M1 1L5 1L5 5Z');
    expect(closed.at(-1)).toEqual({ command: 'Z', values: [] });
    expect(isClosed(closed)).toBe(true);
    expect(isClosed(parsePathData('M0 0L1 1'))).toBe(false);
  });

  it('ignores malformed trailing data instead of throwing', () => {
    expect(() => parsePathData('M0 0 L')).not.toThrow();
  });
});

describe('arcs', () => {
  it('approximates a circle to within a fraction of a percent', () => {
    // Two half-arcs make a full circle of radius 10 centred on the origin.
    const box = bbox('M-10 0A10 10 0 1 0 10 0A10 10 0 1 0 -10 0Z');
    expect(box.x).toBeCloseTo(-10, 2);
    expect(box.w).toBeCloseTo(20, 2);
    expect(box.h).toBeCloseTo(20, 2);
  });

  it('scales radii up when they are too small to reach the endpoint', () => {
    const box = bbox('M0 0A1 1 0 0 1 10 0');
    expect(box.w).toBeCloseTo(10, 3);
  });

  it('degenerates to a line when a radius is zero', () => {
    expect(parsePathData('M0 0A0 5 0 0 1 10 0')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [10, 0] },
    ]);
  });

  it('honours the sweep flag', () => {
    const up = pathBBox(parsePathData('M0 0A5 5 0 0 1 10 0'))!;
    const down = pathBBox(parsePathData('M0 0A5 5 0 0 0 10 0'))!;
    expect(up.y).toBeLessThan(0); // sweeps above the chord
    expect(down.y).toBeCloseTo(0, 6);
    expect(down.h).toBeGreaterThan(0);
  });
});

describe('parseTransform', () => {
  it('parses translate, scale, rotate and matrix', () => {
    expect(applyMatrix(parseTransform('translate(5 7)'), 1, 1)).toEqual([6, 8]);
    expect(applyMatrix(parseTransform('scale(2 3)'), 2, 2)).toEqual([4, 6]);

    const [x, y] = applyMatrix(parseTransform('rotate(90)'), 1, 0);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(1, 9);

    expect(applyMatrix(parseTransform('matrix(1 0 0 1 4 5)'), 0, 0)).toEqual([4, 5]);
  });

  it('rotates about a given centre', () => {
    const [x, y] = applyMatrix(parseTransform('rotate(180 5 5)'), 6, 5);
    expect(x).toBeCloseTo(4, 9);
    expect(y).toBeCloseTo(5, 9);
  });

  it('applies a list left to right', () => {
    const [x, y] = applyMatrix(parseTransform('translate(10 0) scale(2)'), 1, 1);
    expect([x, y]).toEqual([12, 2]);
  });

  it('is the identity for missing or unparseable input', () => {
    expect(parseTransform(undefined)).toEqual(IDENTITY);
    expect(parseTransform('nonsense')).toEqual(IDENTITY);
  });

  it('reports a usable scale factor for stroke widths', () => {
    expect(matrixScale(parseTransform('scale(3)'))).toBeCloseTo(3, 9);
    expect(matrixScale(parseTransform('rotate(37)'))).toBeCloseTo(1, 9);
  });
});

describe('transformSegments', () => {
  it('moves every control point', () => {
    const moved = transformSegments(parsePathData('M0 0C1 1 2 2 3 3'), parseTransform('translate(1 2)'));
    expect(moved[1]!.values).toEqual([2, 3, 3, 4, 4, 5]);
  });

  it('composes with multiply the same way nested groups do', () => {
    const outer = parseTransform('translate(10 0)');
    const inner = parseTransform('scale(2)');
    const combined = transformSegments(parsePathData('M1 1'), multiply(outer, inner));
    expect(combined[0]!.values).toEqual([12, 2]);
  });

  it('leaves close commands alone', () => {
    const segments = transformSegments(parsePathData('M0 0L1 1Z'), parseTransform('scale(2)'));
    expect(segments.at(-1)).toEqual({ command: 'Z', values: [] });
  });
});

describe('pathBBox', () => {
  it('bounds straight geometry exactly', () => {
    expect(bbox('M1 2L5 2L5 9Z')).toEqual({ x: 1, y: 2, w: 4, h: 7 });
  });

  it('solves cubic extremes rather than using control points', () => {
    // Control points reach y = 10, but the curve itself only reaches 7.5.
    const box = bbox('M0 0C0 10 10 10 10 0');
    expect(box.h).toBeCloseTo(7.5, 6);
  });

  it('returns null for an empty path', () => {
    expect(pathBBox([])).toBeNull();
  });
});

describe('serialization', () => {
  it('round-trips through parse and serialize', () => {
    const source = 'M0 0 L10 0 C10 5.5 5.5 10 0 10 Z';
    const once = parsePathData(source);
    const twice = parsePathData(serializePathData(once));
    expect(twice).toEqual(once);
  });

  it('counts nodes without counting closes', () => {
    expect(countNodes(parsePathData('M0 0L1 1L2 2Z'))).toBe(3);
  });
});
