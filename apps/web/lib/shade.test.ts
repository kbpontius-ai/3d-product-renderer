import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  heightLayerRangeMm,
  HEIGHT_LAYER_RANGE_MM,
  MIN_HEIGHT_LAYER_RANGE_MM,
  shadeArtwork,
} from './shade';
import type { FinishParams } from '@pr/artwork';

/**
 * The height layer is 8 bits, so its encode range is its step size. Under the old bump shader that
 * was invisible; once the layer displaces geometry (`F-PREV-06`) the steps are terraces on the wall
 * of the relief, so the range has to follow the design instead of sitting at the schema maximum.
 */
describe('heightLayerRangeMm', () => {
  it('leaves headroom above the relief depth', () => {
    expect(heightLayerRangeMm(0.3)).toBeCloseTo(0.375, 6);
    expect(heightLayerRangeMm(0.6)).toBeCloseTo(0.75, 6);
  });

  it('never narrows past the floor', () => {
    expect(heightLayerRangeMm(0.01)).toBe(MIN_HEIGHT_LAYER_RANGE_MM);
    expect(heightLayerRangeMm(0)).toBe(MIN_HEIGHT_LAYER_RANGE_MM);
  });

  it('never widens past the schema maximum', () => {
    expect(heightLayerRangeMm(100)).toBe(HEIGHT_LAYER_RANGE_MM);
  });

  it('answers for a design with no relief at all', () => {
    expect(heightLayerRangeMm(null)).toBe(MIN_HEIGHT_LAYER_RANGE_MM);
    expect(heightLayerRangeMm(undefined)).toBe(MIN_HEIGHT_LAYER_RANGE_MM);
    expect(heightLayerRangeMm(Number.NaN)).toBe(MIN_HEIGHT_LAYER_RANGE_MM);
  });

  it('buys enough levels that a typical emboss cannot terrace', () => {
    // Codes across the relief itself: 255 codes span 2 x range, so depth / (2 x range / 255).
    const depth = 0.3;
    const levels = depth / ((2 * heightLayerRangeMm(depth)) / 255);
    expect(levels).toBeGreaterThan(100);

    // What it used to be, for contrast — 25 steps is a visible staircase on a displaced wall.
    const before = depth / ((2 * HEIGHT_LAYER_RANGE_MM) / 255);
    expect(before).toBeLessThan(30);
  });
});

describe('sampled surface color', () => {
  afterEach(() => vi.unstubAllGlobals());

  const finish: FinishParams = { kind: 'emboss', depthMm: 0.35, bevelDeg: 30, edgeRadiusMm: 0.05 };
  function draw(
    color: string,
    options: { inkColorHex?: string; outside?: boolean; edge?: boolean } = {},
  ) {
    vi.stubGlobal(
      'ImageData',
      class {
        data: Uint8ClampedArray;
        constructor(
          public width: number,
          public height: number,
        ) {
          this.data = new Uint8ClampedArray(width * height * 4);
        }
      },
    );
    const data = new Float32Array(25).fill(10);
    if (options.edge) for (let i = 0; i < data.length; i++) data[i] = ((i % 5) - 1) * 0.1;
    return shadeArtwork(
      { width: 5, height: 5, data, mmPerPx: 0.1, minMm: -0.1, maxMm: 10 },
      { width: 5, height: 5, data: new Uint8Array(25).fill(options.outside ? 0 : 255) },
      {
        finish,
        partColorHex: color,
        matchSurfaceColor: true,
        ...(options.inkColorHex ? { inkColorHex: options.inkColorHex } : {}),
      },
    );
  }

  it.each(['#b78d4d', '#000000', '#ffffff', '#2255aa'])(
    'keeps a flat raised region at its sampled color: %s',
    (hex) => {
      const image = draw(hex);
      expect([...image.data.slice(48, 51)]).toEqual([
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ]);
    },
  );

  it('retains contrast at a relief edge', () => {
    const image = draw('#b78d4d', { edge: true });
    expect([...image.data.slice(48, 51)]).not.toEqual([183, 141, 77]);
  });

  it('does not tint ink with the sampled substrate color', () => {
    expect(draw('#b78d4d', { inkColorHex: '#2255aa' }).data).toEqual(
      draw('#ff0000', { inkColorHex: '#2255aa' }).data,
    );
  });

  it('leaves uncovered artwork pixels transparent', () => {
    expect(draw('#b78d4d', { outside: true }).data.every((value) => value === 0)).toBe(true);
  });
});
