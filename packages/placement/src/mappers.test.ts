import { describe, expect, it } from 'vitest';
import type { DecorationZoneDef } from '@pr/design-schema';
import { cylindricalZoneFixture, planarZoneFixture } from '@pr/design-schema/fixtures';
import { mapperFor, uvFromRect, wrapAngleDeg, ZoneMappingError } from './mappers.js';
import { length, sub } from './vec.js';

describe('planar zone mapper', () => {
  const m = mapperFor(planarZoneFixture);

  it('places the zone origin at the frame origin', () => {
    expect(m.toWorld({ x: 0, y: 0 }).position).toEqual([0, 18, 0]);
  });

  it('moves along the frame tangent for +x', () => {
    expect(m.toWorld({ x: 5, y: 0 }).position).toEqual([5, 18, 0]);
  });

  it('round-trips world <-> zone', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 4.2, y: -7.9 },
      { x: -12, y: 3 },
    ]) {
      const back = m.fromWorld(m.toWorld(p).position);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('preserves distances (metric = 1)', () => {
    const a = m.toWorld({ x: 0, y: 0 }).position;
    const b = m.toWorld({ x: 3, y: 4 }).position;
    expect(length(sub(b, a))).toBeCloseTo(5, 9);
    expect(m.metric({ x: 0, y: 0 })).toBe(1);
  });
});

describe('cylindrical zone mapper', () => {
  const zone = cylindricalZoneFixture;
  const m = mapperFor(zone);
  const radius = zone.frame.radiusMm;

  it('sits on the cylinder surface at the zone centre', () => {
    const p = m.toWorld({ x: 0, y: 0 }).position;
    expect(Math.hypot(p[0], p[2])).toBeCloseTo(radius, 9);
    expect(p[1]).toBeCloseTo(8, 9);
  });

  it('treats +x as arc length, not angle', () => {
    const a = m.toWorld({ x: 0, y: 0 }).position;
    const b = m.toWorld({ x: 1, y: 0 }).position;
    const chord = length(sub(b, a));
    // Chord slightly shorter than arc, but within 0.1% for 1 mm on a 19 mm radius.
    expect(chord).toBeGreaterThan(0.999);
    expect(chord).toBeLessThanOrEqual(1);
  });

  it('unrolls isometrically over the zone height', () => {
    const a = m.toWorld({ x: 0, y: -4 }).position;
    const b = m.toWorld({ x: 0, y: 4 }).position;
    expect(length(sub(b, a))).toBeCloseTo(8, 9);
  });

  it('round-trips world <-> zone', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 6.5, y: 2 },
      { x: -9, y: -3.5 },
    ]) {
      const back = m.fromWorld(m.toWorld(p).position);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('returns an outward normal and a circumferential tangent', () => {
    const s = m.toWorld({ x: 0, y: 0 });
    expect(length(s.normal)).toBeCloseTo(1, 9);
    expect(length(s.tangent)).toBeCloseTo(1, 9);
    expect(s.normal[0] * s.tangent[0] + s.normal[2] * s.tangent[2]).toBeCloseTo(0, 9);
  });
});

describe('uv zones', () => {
  const zone: DecorationZoneDef = {
    type: 'uv_rect',
    key: 'panel',
    name: 'Front panel',
    uvSet: 'decor',
    uvRect: { u0: 0.25, v0: 0.5, u1: 0.75, v1: 1 },
    sizeMm: { width: 100, height: 60, safeMarginMm: 3 },
    constraints: {
      finishes: ['print'],
      maxDepthMm: 0.6,
      minStrokeMm: 0.25,
      maxCoverage: 0.9,
      wrapWarnDeg: 120,
    },
  };
  const m = mapperFor(zone);

  it('maps the zone centre to the centre of the uv rect', () => {
    expect(m.toUv({ x: 0, y: 0 })).toEqual({ x: 0.5, y: 0.75 });
  });

  it('maps zone corners to uv rect corners', () => {
    expect(m.toUv({ x: -50, y: -30 })).toEqual({ x: 0.25, y: 0.5 });
    expect(m.toUv({ x: 50, y: 30 })).toEqual({ x: 0.75, y: 1 });
  });

  it('requires a mesh sampler for world positions', () => {
    expect(() => m.toWorld({ x: 0, y: 0 })).toThrow(ZoneMappingError);
  });

  it('uses the mesh sampler when one is supplied', () => {
    const sampler = {
      sampleByUv: () => ({ position: [1, 2, 3] as const, normal: [0, 1, 0] as const, tangent: [1, 0, 0] as const }),
      uvMetricAt: () => 1.04,
    };
    const withMesh = mapperFor(zone, sampler as never);
    expect(withMesh.toWorld({ x: 0, y: 0 }).position).toEqual([1, 2, 3]);
    expect(withMesh.metric({ x: 0, y: 0 })).toBe(1.04);
  });
});

describe('uvFromRect', () => {
  it('is linear across the rect', () => {
    const uv = uvFromRect({ x: 0, y: 0 }, { w: 10, h: 10, safeMarginMm: 0 }, { u0: 0, v0: 0, u1: 1, v1: 1 });
    expect(uv).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('wrapAngleDeg', () => {
  it('is null for zones that do not wrap', () => {
    expect(wrapAngleDeg(planarZoneFixture, 10)).toBeNull();
  });

  it('converts arc width to degrees on a cylinder', () => {
    // 19 mm radius: half the circumference (~59.7 mm) is 180 degrees.
    expect(wrapAngleDeg(cylindricalZoneFixture, Math.PI * 19)).toBeCloseTo(180, 6);
  });
});
