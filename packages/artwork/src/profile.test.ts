import { describe, expect, it } from 'vitest';
import {
  dHeightdD,
  fullDepthWidthMm,
  heightMm,
  MAX_SLOPE,
  peakHeightMm,
  profileGeometry,
  wallWidthMm,
  type FinishParams,
} from './profile.js';

const emboss = (over: Partial<FinishParams> = {}): FinishParams => ({
  depthMm: 0.4,
  bevelDeg: 30,
  edgeRadiusMm: 0.05,
  kind: 'emboss',
  ...over,
});

describe('wallWidthMm', () => {
  it('is depth/tan(bevel)', () => {
    expect(wallWidthMm(1, 45)).toBeCloseTo(1, 9);
    expect(wallWidthMm(1, 30)).toBeCloseTo(Math.sqrt(3), 6);
  });

  it('collapses to zero for a vertical wall', () => {
    expect(wallWidthMm(1, 90)).toBe(0);
  });
});

describe('heightMm', () => {
  it('is zero outside the artwork', () => {
    expect(heightMm(-0.1, emboss())).toBe(0);
    expect(heightMm(0, emboss())).toBe(0);
  });

  it('reaches exactly full depth on the plateau', () => {
    const p = emboss();
    const g = profileGeometry(p);
    expect(heightMm(g.plateauMm, p)).toBeCloseTo(p.depthMm, 9);
    expect(heightMm(g.plateauMm * 10, p)).toBeCloseTo(p.depthMm, 9);
  });

  it('is monotonically non-decreasing across the whole profile', () => {
    const p = emboss({ depthMm: 0.6, bevelDeg: 25, edgeRadiusMm: 0.08 });
    let prev = -Infinity;
    for (let d = 0; d <= 3; d += 0.001) {
      const h = heightMm(d, p);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = h;
    }
  });

  it('is continuous at the ramp/fillet and fillet/plateau joints', () => {
    const p = emboss({ depthMm: 0.5, bevelDeg: 35, edgeRadiusMm: 0.1 });
    const g = profileGeometry(p);
    for (const joint of [g.tangentMm, g.plateauMm]) {
      const before = heightMm(joint - 1e-6, p);
      const after = heightMm(joint + 1e-6, p);
      expect(Math.abs(after - before)).toBeLessThan(1e-5);
    }
  });

  it('follows the linear ramp below the fillet', () => {
    const p = emboss({ depthMm: 1, bevelDeg: 45, edgeRadiusMm: 0.1 });
    const g = profileGeometry(p);
    const d = g.tangentMm / 2;
    expect(heightMm(d, p)).toBeCloseTo(g.slope * d, 9);
  });

  it('rounds the corner: the fillet sits below the un-filleted ramp', () => {
    const p = emboss({ depthMm: 1, bevelDeg: 45, edgeRadiusMm: 0.2 });
    const g = profileGeometry(p);
    const d = (g.tangentMm + g.plateauMm) / 2;
    expect(heightMm(d, p)).toBeLessThan(Math.min(g.slope * d, p.depthMm));
  });

  it('mirrors emboss for deboss', () => {
    const e = emboss();
    const d = { ...e, kind: 'deboss' as const };
    for (const x of [0.01, 0.1, 0.4, 2]) {
      expect(heightMm(x, d)).toBeCloseTo(-heightMm(x, e), 12);
      expect(dHeightdD(x, d)).toBeCloseTo(-dHeightdD(x, e), 12);
    }
  });

  it('drops straight to full depth for a vertical wall with no fillet', () => {
    const p = emboss({ bevelDeg: 90, edgeRadiusMm: 0 });
    // The wall is a step at d = 0: flat top immediately, no ramp to traverse. Edge coverage (not
    // the slope) is what antialiases it in the shader.
    expect(heightMm(1e-6, p)).toBeCloseTo(p.depthMm, 9);
    expect(dHeightdD(1e-6, p)).toBe(0);
    expect(heightMm(-1e-6, p)).toBe(0);
  });

  it('ramps through the fillet for a vertical wall with a rounded edge', () => {
    const p = emboss({ bevelDeg: 90, edgeRadiusMm: 0.1, depthMm: 0.4 });
    const g = profileGeometry(p);
    expect(g.plateauMm).toBeCloseTo(0.1, 9);
    expect(heightMm(0.05, p)).toBeGreaterThan(p.depthMm - 0.1);
    expect(heightMm(0.05, p)).toBeLessThan(p.depthMm);
    expect(dHeightdD(1e-9, p)).toBe(MAX_SLOPE);
  });
});

describe('dHeightdD', () => {
  it('matches a numeric derivative of heightMm', () => {
    const p = emboss({ depthMm: 0.5, bevelDeg: 30, edgeRadiusMm: 0.06 });
    const g = profileGeometry(p);
    const samples = [g.tangentMm * 0.5, g.tangentMm * 0.9, (g.tangentMm + g.plateauMm) / 2, g.plateauMm * 1.5];
    const h = 1e-6;
    for (const d of samples) {
      const numeric = (heightMm(d + h, p) - heightMm(d - h, p)) / (2 * h);
      expect(dHeightdD(d, p)).toBeCloseTo(numeric, 3);
    }
  });

  it('is zero on the plateau', () => {
    const p = emboss();
    expect(dHeightdD(profileGeometry(p).plateauMm + 0.1, p)).toBe(0);
  });
});

describe('thin features', () => {
  it('never reaches full depth below the full-depth width', () => {
    const p = emboss({ depthMm: 0.4, bevelDeg: 30, edgeRadiusMm: 0.05 });
    const wFull = fullDepthWidthMm(p);
    expect(peakHeightMm(wFull, p)).toBeCloseTo(p.depthMm, 9);
    expect(peakHeightMm(wFull * 0.5, p)).toBeLessThan(p.depthMm);
    expect(peakHeightMm(wFull * 0.1, p)).toBeLessThan(p.depthMm * 0.2);
  });

  it('shallower bevels need wider features to reach full depth', () => {
    const steep = emboss({ bevelDeg: 60 });
    const shallow = emboss({ bevelDeg: 15 });
    expect(fullDepthWidthMm(shallow)).toBeGreaterThan(fullDepthWidthMm(steep));
  });
});

describe('fillet clamping', () => {
  it('never exceeds half the depth or half the wall run', () => {
    const g = profileGeometry(emboss({ depthMm: 0.2, bevelDeg: 60, edgeRadiusMm: 5 }));
    expect(g.radiusMm).toBeLessThanOrEqual(0.1 + 1e-12);
    expect(g.radiusMm).toBeLessThanOrEqual(g.wallMm / 2 + 1e-12);
  });
});
