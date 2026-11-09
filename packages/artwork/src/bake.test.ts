import { describe, expect, it } from 'vitest';
import { bakeHeight16, bakeInkCoverage8, heightFieldMm, HEIGHT_ENCODE_RANGE_MM } from './bake.js';
import { decode16, signedDistanceFieldMm, type Gray } from './sdf.js';
import { fullDepthWidthMm, type FinishParams } from './profile.js';

const mmPerPx = 0.02;

function barMask(size: number, widthPx: number): Gray {
  const data = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = widthPx / 2 - Math.abs(x - c);
      data[y * size + x] = Math.round(Math.max(0, Math.min(1, d + 0.5)) * 255);
    }
  }
  return { data, width: size, height: size };
}

const emboss = (over: Partial<FinishParams> = {}): FinishParams => ({
  depthMm: 0.4,
  bevelDeg: 30,
  edgeRadiusMm: 0.05,
  kind: 'emboss',
  ...over,
});

describe('heightFieldMm', () => {
  it('is zero outside the artwork and full depth in a wide interior', () => {
    const field = signedDistanceFieldMm(barMask(129, 81), mmPerPx);
    const h = heightFieldMm(field, emboss());
    expect(h[64 * 129 + 2]).toBe(0); // outside the bar
    expect(h[64 * 129 + 64]).toBeCloseTo(0.4, 6); // centre of a wide bar
  });

  it('is negative everywhere inside a debossed feature', () => {
    const field = signedDistanceFieldMm(barMask(129, 81), mmPerPx);
    const h = heightFieldMm(field, emboss({ kind: 'deboss' }));
    expect(h[64 * 129 + 64]).toBeCloseTo(-0.4, 6);
  });
});

describe('bakeHeight16', () => {
  it('round-trips through the fixed encode range', () => {
    // The bar must be wider than 2 x the draft wall, or the centre never reaches full depth.
    const field = signedDistanceFieldMm(barMask(129, 81), mmPerPx);
    const baked = bakeHeight16(field, emboss());
    expect(baked.rangeMm).toBe(HEIGHT_ENCODE_RANGE_MM);
    const centre = decode16(baked.data[64 * 129 + 64]!, baked.rangeMm);
    expect(centre).toBeCloseTo(0.4, 3);
  });

  it('reports a peak below the requested depth for thin features', () => {
    const params = emboss();
    const fullWidthPx = fullDepthWidthMm(params) / mmPerPx;
    const thin = bakeHeight16(signedDistanceFieldMm(barMask(129, fullWidthPx * 0.4), mmPerPx), params);
    const wide = bakeHeight16(signedDistanceFieldMm(barMask(129, fullWidthPx * 2), mmPerPx), params);

    expect(Math.abs(thin.peakMm)).toBeLessThan(params.depthMm);
    expect(Math.abs(wide.peakMm)).toBeCloseTo(params.depthMm, 3);
  });

  it('keeps the sign of a debossed peak', () => {
    const field = signedDistanceFieldMm(barMask(129, 81), mmPerPx);
    expect(bakeHeight16(field, emboss({ kind: 'deboss' })).peakMm).toBeLessThan(0);
  });
});

describe('bakeInkCoverage8', () => {
  it('is opaque inside, clear outside, and feathered at the edge', () => {
    const field = signedDistanceFieldMm(barMask(65, 21), mmPerPx);
    const ink = bakeInkCoverage8(field);
    expect(ink[32 * 65 + 32]).toBe(255);
    expect(ink[32 * 65 + 1]).toBe(0);

    const edge = ink[32 * 65 + Math.round(32 + 21 / 2)]!;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });
});
