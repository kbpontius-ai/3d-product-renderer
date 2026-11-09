import { describe, expect, it } from 'vitest';
import {
  decode16,
  encode16,
  encodeFieldTo16,
  sampleField,
  signedDistanceFieldMm,
  squaredDistanceTransform,
  type Gray,
} from './sdf.js';

/** Antialiased disc, coverage estimated by distance from the edge. */
function discMask(size: number, radiusPx: number): Gray {
  const data = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = radiusPx - Math.hypot(x - c, y - c); // positive inside
      const coverage = Math.max(0, Math.min(1, d + 0.5));
      data[y * size + x] = Math.round(coverage * 255);
    }
  }
  return { data, width: size, height: size };
}

/** Axis-aligned bar with antialiased edges, centred on the middle column. */
function barMask(size: number, widthPx: number): Gray {
  const data = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = widthPx / 2 - Math.abs(x - c); // positive inside
      data[y * size + x] = Math.round(Math.max(0, Math.min(1, d + 0.5)) * 255);
    }
  }
  return { data, width: size, height: size };
}

describe('squaredDistanceTransform', () => {
  it('is zero on feature pixels', () => {
    const d = squaredDistanceTransform(5, 5, (i) => i === 12);
    expect(d[12]).toBe(0);
  });

  it('matches exact Euclidean distances from a single feature pixel', () => {
    const w = 9;
    const d = squaredDistanceTransform(w, w, (i) => i === 4 * w + 4);
    for (const [x, y, expected] of [
      [4, 5, 1],
      [6, 4, 4],
      [7, 7, 18],
      [0, 0, 32],
    ] as const) {
      expect(d[y * w + x]).toBeCloseTo(expected, 9);
    }
  });
});

describe('signedDistanceFieldMm', () => {
  const mmPerPx = 0.02;

  it('is positive inside and negative outside', () => {
    const field = signedDistanceFieldMm(discMask(65, 20), mmPerPx);
    const c = 32;
    expect(sampleField(field, c, c)).toBeGreaterThan(0);
    expect(sampleField(field, 1, 1)).toBeLessThan(0);
  });

  it('reports the disc radius at the centre within the documented one-pixel bound', () => {
    const radiusPx = 20;
    const field = signedDistanceFieldMm(discMask(65, radiusPx), mmPerPx);
    const centre = sampleField(field, 32, 32);
    expect(Math.abs(centre - radiusPx * mmPerPx)).toBeLessThan(mmPerPx);
  });

  it('crosses zero at the edge', () => {
    const radiusPx = 20;
    const field = signedDistanceFieldMm(discMask(65, radiusPx), mmPerPx);
    expect(Math.abs(sampleField(field, 32 + radiusPx, 32))).toBeLessThan(mmPerPx);
  });

  it('has unit gradient magnitude away from the edge (|grad sdf| = 1)', () => {
    const field = signedDistanceFieldMm(discMask(129, 40), mmPerPx);
    for (const [x, y] of [
      [64, 44],
      [50, 64],
      [64, 90],
    ] as const) {
      const gx = (sampleField(field, x + 1, y) - sampleField(field, x - 1, y)) / (2 * mmPerPx);
      const gy = (sampleField(field, x, y + 1) - sampleField(field, x, y - 1)) / (2 * mmPerPx);
      expect(Math.hypot(gx, gy)).toBeCloseTo(1, 1);
    }
  });

  it('caps a thin bar at half its width — the reason thin strokes emboss shallow', () => {
    const widthPx = 7;
    const field = signedDistanceFieldMm(barMask(65, widthPx), mmPerPx);
    const peak = sampleField(field, 32, 32);
    expect(Math.abs(peak - (widthPx / 2) * mmPerPx)).toBeLessThan(mmPerPx);
  });

  it('grows the peak with the bar width', () => {
    const narrow = sampleField(signedDistanceFieldMm(barMask(65, 5), mmPerPx), 32, 32);
    const wide = sampleField(signedDistanceFieldMm(barMask(65, 15), mmPerPx), 32, 32);
    expect(wide).toBeGreaterThan(narrow);
  });
});

describe('16-bit encoding', () => {
  it('round-trips within one quantisation step', () => {
    const range = [-2, 3] as const;
    const step = (range[1] - range[0]) / 65535;
    for (const v of [-2, -0.5, 0, 1.234, 3]) {
      expect(decode16(encode16(v, range), range)).toBeCloseTo(v, 4);
      expect(Math.abs(decode16(encode16(v, range), range) - v)).toBeLessThanOrEqual(step);
    }
  });

  it('clamps out-of-range values instead of wrapping', () => {
    const range = [0, 1] as const;
    expect(encode16(-5, range)).toBe(0);
    expect(encode16(5, range)).toBe(65535);
  });

  it('encodes a whole field against its own range', () => {
    const field = signedDistanceFieldMm(discMask(33, 10), 0.05);
    const { data, range } = encodeFieldTo16(field);
    expect(data.length).toBe(field.data.length);
    expect(decode16(data[0]!, range)).toBeCloseTo(field.data[0]!, 3);
  });
});
