import { describe, expect, it } from 'vitest';
import type { Transform } from '@pr/design-schema';
import {
  aabb,
  anchorForHandle,
  clampToZone,
  corners,
  DEFAULT_FILL,
  fitSize,
  initialTransform,
  isInsideSafeArea,
  isInsideZone,
  normalizeDeg,
  quantize,
  rotateTo,
  scaleFromHandle,
} from './transform.js';

const zone = { w: 30, h: 30, safeMarginMm: 1.5 };

const tf = (over: Partial<Transform> = {}): Transform => ({
  offsetMm: { x: 0, y: 0 },
  sizeMm: { w: 10, h: 10 },
  rotationDeg: 0,
  flipX: false,
  flipY: false,
  lockAspect: true,
  ...over,
});

describe('corners / aabb', () => {
  it('is symmetric about the offset when unrotated', () => {
    const b = aabb(tf());
    expect(b.min).toEqual({ x: -5, y: -5 });
    expect(b.max).toEqual({ x: 5, y: 5 });
  });

  it('grows the bounding box when rotated 45 degrees', () => {
    const b = aabb(tf({ rotationDeg: 45 }));
    expect(b.max.x).toBeCloseTo(Math.SQRT2 * 5, 6);
    expect(b.max.y).toBeCloseTo(Math.SQRT2 * 5, 6);
  });

  it('swaps extents when rotated 90 degrees', () => {
    const b = aabb(tf({ sizeMm: { w: 20, h: 6 }, rotationDeg: 90 }));
    expect(b.max.x - b.min.x).toBeCloseTo(6, 6);
    expect(b.max.y - b.min.y).toBeCloseTo(20, 6);
  });

  it('tracks the offset', () => {
    const b = aabb(tf({ offsetMm: { x: 3, y: -2 } }));
    expect(b.min).toEqual({ x: -2, y: -7 });
  });

  it('returns four corners', () => {
    expect(corners(tf())).toHaveLength(4);
  });
});

describe('fitSize', () => {
  const natural = { w: 40, h: 10 };

  it('contains inside the safe area', () => {
    const s = fitSize(natural, zone, 'contain');
    expect(s.w).toBeCloseTo(27, 6); // 30 - 2 * 1.5
    expect(s.h).toBeCloseTo(6.75, 6);
  });

  it('covers the safe area', () => {
    const s = fitSize(natural, zone, 'cover');
    expect(s.h).toBeCloseTo(27, 6);
  });

  it('returns natural size unchanged', () => {
    expect(fitSize(natural, zone, 'natural')).toEqual(natural);
  });

  it('preserves aspect ratio in every mode', () => {
    for (const mode of ['contain', 'cover'] as const) {
      const s = fitSize(natural, zone, mode);
      expect(s.w / s.h).toBeCloseTo(natural.w / natural.h, 9);
    }
  });
});

describe('initialTransform', () => {
  it('centres the artwork and fills most of the safe area', () => {
    const t = initialTransform({ w: 40, h: 10 }, zone);
    expect(t.offsetMm).toEqual({ x: 0, y: 0 });
    expect(t.sizeMm.w).toBeCloseTo(27 * DEFAULT_FILL, 2);
    expect(isInsideSafeArea(t, zone)).toBe(true);
  });
});

describe('clampToZone', () => {
  it('leaves an interior placement alone', () => {
    const t = tf({ offsetMm: { x: 2, y: 2 } });
    const r = clampToZone(t, zone);
    expect(r.hitBoundary).toBe(false);
    expect(r.transform).toBe(t);
  });

  it('pulls an overhanging placement back inside and reports the boundary hit', () => {
    const r = clampToZone(tf({ offsetMm: { x: 12, y: 0 } }), zone);
    expect(r.hitBoundary).toBe(true);
    expect(aabb(r.transform).max.x).toBeCloseTo(15, 6);
    expect(isInsideZone(r.transform, zone)).toBe(true);
  });

  it('centres artwork that is simply too large to fit', () => {
    const r = clampToZone(tf({ sizeMm: { w: 50, h: 50 }, offsetMm: { x: 9, y: -4 } }), zone);
    expect(r.transform.offsetMm.x).toBeCloseTo(0, 6);
    expect(r.transform.offsetMm.y).toBeCloseTo(0, 6);
  });

  it('accounts for rotation when clamping', () => {
    const r = clampToZone(tf({ rotationDeg: 45, offsetMm: { x: 14, y: 0 } }), zone);
    expect(aabb(r.transform).max.x).toBeCloseTo(15, 6);
  });
});

describe('scaleFromHandle', () => {
  it('keeps the opposite corner anchored', () => {
    const start = tf();
    const before = aabb(start);
    const next = scaleFromHandle(start, 'se', { x: 10, y: -10 }, { proportional: true });
    const after = aabb(next);
    expect(after.min.x).toBeCloseTo(before.min.x, 6); // NW corner unmoved
    expect(after.max.y).toBeCloseTo(before.max.y, 6);
    expect(next.sizeMm.w).toBeCloseTo(15, 6);
    expect(next.sizeMm.h).toBeCloseTo(15, 6);
  });

  it('scales proportionally from a corner handle', () => {
    const next = scaleFromHandle(tf({ sizeMm: { w: 20, h: 10 } }), 'ne', { x: 20, y: 20 }, { proportional: true });
    expect(next.sizeMm.w / next.sizeMm.h).toBeCloseTo(2, 6);
  });

  it('stretches one axis from an edge handle', () => {
    const next = scaleFromHandle(tf(), 'e', { x: 12, y: 0 }, { proportional: false });
    expect(next.sizeMm.w).toBeCloseTo(17, 6);
    expect(next.sizeMm.h).toBeCloseTo(10, 6);
  });

  it('never scales below the minimum size', () => {
    const next = scaleFromHandle(tf(), 'se', { x: -4.9, y: 4.9 }, { proportional: false, minSizeMm: 0.5 });
    expect(next.sizeMm.w).toBeGreaterThanOrEqual(0.5);
    expect(next.sizeMm.h).toBeGreaterThanOrEqual(0.5);
  });

  it('works in the placement basis when rotated', () => {
    const start = tf({ rotationDeg: 30 });
    const next = scaleFromHandle(start, 'se', { x: 8, y: -8 }, { proportional: true });
    expect(next.rotationDeg).toBe(30);
    expect(next.sizeMm.w).toBeGreaterThan(start.sizeMm.w);
  });
});

describe('anchorForHandle', () => {
  it('picks the opposite corner', () => {
    expect(anchorForHandle('se', tf())).toEqual({ x: -5, y: 5 });
    expect(anchorForHandle('nw', tf())).toEqual({ x: 5, y: -5 });
  });

  it('picks the opposite edge midpoint', () => {
    expect(anchorForHandle('e', tf())).toEqual({ x: -5, y: 0 });
  });
});

describe('rotateTo', () => {
  it('snaps to 15 degree increments by default', () => {
    const t = rotateTo(tf(), { x: 10, y: 1.5 }, false);
    expect(t.rotationDeg % 15).toBeCloseTo(0, 9);
  });

  it('is freeform when asked', () => {
    const t = rotateTo(tf(), { x: 10, y: 1 }, true);
    expect(t.rotationDeg).toBeCloseTo((Math.atan2(1, 10) * 180) / Math.PI, 6);
  });
});

describe('quantize', () => {
  it('rounds millimetres to 0.01 and degrees to 0.1', () => {
    const t = quantize(tf({ offsetMm: { x: 1.23456, y: -0.00499 }, rotationDeg: 12.3456 }));
    expect(t.offsetMm.x).toBeCloseTo(1.23, 9);
    expect(t.offsetMm.y).toBeCloseTo(-0, 9);
    expect(t.rotationDeg).toBeCloseTo(12.3, 9);
  });
});

describe('normalizeDeg', () => {
  it('wraps into (-180, 180]', () => {
    expect(normalizeDeg(370)).toBeCloseTo(10, 9);
    expect(normalizeDeg(-190)).toBeCloseTo(170, 9);
    expect(normalizeDeg(180)).toBe(180);
  });
});
