import { describe, expect, it } from 'vitest';
import { parsePathData, prepareArtwork } from '@pr/svg';
import { flattenSegments, polygonBounds } from './flatten.js';
import { coverageFraction, rasterizeCoverage, type CoverageMask } from './scanline.js';
import { strokeToPolygons } from './stroke.js';
import { choosePitchMm, rasterizeArtwork } from './artwork.js';

const at = (mask: CoverageMask, x: number, y: number) => mask.data[y * mask.width + x]!;

const inkedArea = (mask: CoverageMask) => {
  let total = 0;
  for (const value of mask.data) total += value / 255;
  return total;
};

describe('flattenSegments', () => {
  it('keeps straight geometry exactly', () => {
    const polygons = flattenSegments(parsePathData('M0 0L10 0L10 10Z'));
    expect(polygons).toHaveLength(1);
    expect(polygons[0]!).toHaveLength(4); // closing point repeats the start
  });

  it('subdivides curves until they are flat enough', () => {
    const coarse = flattenSegments(parsePathData('M0 0C0 20 20 20 20 0'), { toleranceUnits: 2 });
    const fine = flattenSegments(parsePathData('M0 0C0 20 20 20 20 0'), { toleranceUnits: 0.01 });
    expect(fine[0]!.length).toBeGreaterThan(coarse[0]!.length);
  });

  it('splits subpaths', () => {
    const polygons = flattenSegments(parsePathData('M0 0L1 0M5 5L6 5'));
    expect(polygons).toHaveLength(2);
  });

  it('reports bounds across polygons', () => {
    const bounds = polygonBounds(flattenSegments(parsePathData('M0 0L10 0L10 4Z')))!;
    expect(bounds).toEqual({ x: 0, y: 0, w: 10, h: 4 });
  });
});

describe('rasterizeCoverage', () => {
  it('fills a pixel-aligned rectangle exactly', () => {
    const mask = rasterizeCoverage(
      [
        [
          [2, 2],
          [8, 2],
          [8, 6],
          [2, 6],
        ],
      ],
      { width: 10, height: 10 },
    );
    expect(at(mask, 4, 4)).toBe(255);
    expect(at(mask, 0, 0)).toBe(0);
    expect(inkedArea(mask)).toBeCloseTo(24, 6); // 6 x 4 pixels
  });

  it('antialiases a half-pixel edge', () => {
    const mask = rasterizeCoverage(
      [
        [
          [2.5, 0],
          [8, 0],
          [8, 10],
          [2.5, 10],
        ],
      ],
      { width: 10, height: 10 },
    );
    expect(at(mask, 2, 5)).toBeGreaterThan(100);
    expect(at(mask, 2, 5)).toBeLessThan(155);
    expect(at(mask, 3, 5)).toBe(255);
  });

  it('matches the analytic area of a circle', () => {
    const radius = 30;
    const circle = Array.from({ length: 720 }, (_, i) => {
      const a = (i / 720) * Math.PI * 2;
      return [64 + Math.cos(a) * radius, 64 + Math.sin(a) * radius] as const;
    });
    const mask = rasterizeCoverage([circle as never], { width: 128, height: 128 });
    expect(inkedArea(mask)).toBeCloseTo(Math.PI * radius * radius, -1);
    expect(Math.abs(inkedArea(mask) - Math.PI * radius * radius) / (Math.PI * radius * radius)).toBeLessThan(0.005);
  });

  it('leaves a hole where winding cancels (nonzero)', () => {
    const outer = ring(64, 64, 40, 1);
    const inner = ring(64, 64, 20, -1); // opposite direction punches the hole
    const mask = rasterizeCoverage([outer, inner], { width: 128, height: 128, fillRule: 'nonzero' });
    expect(at(mask, 64, 64)).toBe(0);
    expect(at(mask, 64, 34)).toBe(255);
  });

  it('leaves a hole regardless of direction under even-odd', () => {
    const outer = ring(64, 64, 40, 1);
    const inner = ring(64, 64, 20, 1); // same direction
    const nonzero = rasterizeCoverage([outer, inner], { width: 128, height: 128, fillRule: 'nonzero' });
    const evenodd = rasterizeCoverage([outer, inner], { width: 128, height: 128, fillRule: 'evenodd' });
    expect(at(nonzero, 64, 64)).toBe(255);
    expect(at(evenodd, 64, 64)).toBe(0);
  });

  it('clips geometry outside the image instead of wrapping it', () => {
    const mask = rasterizeCoverage(
      [
        [
          [-50, -50],
          [5, -50],
          [5, 5],
          [-50, 5],
        ],
      ],
      { width: 10, height: 10 },
    );
    expect(at(mask, 0, 0)).toBe(255);
    expect(at(mask, 9, 9)).toBe(0);
  });

  it('closes unclosed polygons rather than leaking', () => {
    const mask = rasterizeCoverage(
      [
        [
          [2, 2],
          [8, 2],
          [8, 8],
        ],
      ],
      { width: 10, height: 10 },
    );
    expect(inkedArea(mask)).toBeCloseTo(18, 0); // the implied triangle
  });

  it('is deterministic', () => {
    const polygon = ring(20, 20, 8, 1);
    const a = rasterizeCoverage([polygon], { width: 40, height: 40 });
    const b = rasterizeCoverage([polygon], { width: 40, height: 40 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('reports coverage as a fraction of the image', () => {
    const mask = rasterizeCoverage(
      [
        [
          [0, 0],
          [5, 0],
          [5, 10],
          [0, 10],
        ],
      ],
      { width: 10, height: 10 },
    );
    expect(coverageFraction(mask)).toBeCloseTo(0.5, 3);
  });
});

describe('strokeToPolygons', () => {
  it('gives a straight stroke the area its width implies', () => {
    const polygons = strokeToPolygons(
      [
        [10, 32],
        [54, 32],
      ],
      { width: 6, cap: 'butt' },
    );
    const mask = rasterizeCoverage(polygons, { width: 64, height: 64 });
    expect(inkedArea(mask)).toBeCloseTo(44 * 6, 0);
  });

  it('rounds the ends when asked', () => {
    const butt = rasterizeCoverage(
      strokeToPolygons(
        [
          [10, 32],
          [54, 32],
        ],
        { width: 8, cap: 'butt' },
      ),
      { width: 64, height: 64 },
    );
    const round = rasterizeCoverage(
      strokeToPolygons(
        [
          [10, 32],
          [54, 32],
        ],
        { width: 8, cap: 'round' },
      ),
      { width: 64, height: 64 },
    );
    expect(inkedArea(round)).toBeGreaterThan(inkedArea(butt));
  });

  it('joins corners without a notch', () => {
    const mask = rasterizeCoverage(
      strokeToPolygons(
        [
          [10, 10],
          [40, 10],
          [40, 40],
        ],
        { width: 8 },
      ),
      { width: 64, height: 64 },
    );
    expect(at(mask, 40, 10)).toBe(255);
  });

  it('ignores zero-width and degenerate strokes', () => {
    expect(strokeToPolygons([[0, 0]], { width: 4 })).toEqual([]);
    expect(
      strokeToPolygons(
        [
          [0, 0],
          [1, 0],
        ],
        { width: 0 },
      ),
    ).toEqual([]);
  });
});

describe('rasterizeArtwork', () => {
  const prepared = (body: string, attrs = 'viewBox="0 0 100 50" width="100mm" height="50mm"') => {
    const result = prepareArtwork(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`);
    if (!result.artwork) throw new Error(result.report.errors[0]?.message ?? 'rejected');
    return result.artwork;
  };

  it('crops to the inked content and reports its size in millimetres', () => {
    const raster = rasterizeArtwork(prepared('<rect x="20" y="10" width="40" height="20" fill="#000"/>'), {
      mmPerPx: 0.1,
      paddingPx: 4,
    })!;
    expect(raster.contentSizeMm.w).toBeCloseTo(40, 6);
    expect(raster.contentSizeMm.h).toBeCloseTo(20, 6);
    expect(raster.mask.width).toBe(Math.round(40 / 0.1) + 8);
    expect(at(raster.mask, 4, 4)).toBe(255); // first inked pixel after the padding
    expect(at(raster.mask, 1, 1)).toBe(0);
  });

  it('honours the requested physical pitch', () => {
    const fine = rasterizeArtwork(prepared('<rect width="10" height="10" fill="#000"/>'), { mmPerPx: 0.05 })!;
    const coarse = rasterizeArtwork(prepared('<rect width="10" height="10" fill="#000"/>'), { mmPerPx: 0.2 })!;
    expect(fine.mask.width).toBeGreaterThan(coarse.mask.width);
    expect(fine.mmPerPx).toBeCloseTo(0.05, 9);
  });

  it('coarsens rather than refuses when the artwork would exceed the size cap', () => {
    const raster = rasterizeArtwork(prepared('<rect width="90" height="40" fill="#000"/>'), {
      mmPerPx: 0.005,
      maxSidePx: 512,
    })!;
    expect(Math.max(raster.mask.width, raster.mask.height)).toBeLessThanOrEqual(512);
    expect(raster.mmPerPx).toBeGreaterThan(0.005);
  });

  it('renders strokes as area', () => {
    const raster = rasterizeArtwork(
      prepared('<path d="M10 25L90 25" stroke="#000" stroke-width="2" fill="none"/>'),
      { mmPerPx: 0.1, paddingPx: 2 },
    )!;
    expect(raster.contentSizeMm.h).toBeCloseTo(2, 1); // the stroke, not a zero-height line
  });

  it('returns null when there is nothing to draw', () => {
    const artwork = prepared('<rect width="10" height="10" fill="#000"/>');
    expect(rasterizeArtwork({ ...artwork, paths: [] }, { mmPerPx: 0.1 })).toBeNull();
  });
});

describe('choosePitchMm', () => {
  it('resolves the shallowest supported bevel across several pixels', () => {
    const pitch = choosePitchMm(30);
    expect(30 / pitch).toBeGreaterThan(512);
    expect(30 / pitch).toBeLessThanOrEqual(4096);
  });

  it('clamps tiny and huge artwork into the supported range', () => {
    expect(2 / choosePitchMm(2)).toBeGreaterThanOrEqual(512);
    expect(2000 / choosePitchMm(2000)).toBeLessThanOrEqual(4096);
  });
});

function ring(cx: number, cy: number, radius: number, direction: 1 | -1) {
  const points = Array.from({ length: 180 }, (_, i) => {
    const a = (i / 180) * Math.PI * 2 * direction;
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius] as const;
  });
  return points as never;
}
