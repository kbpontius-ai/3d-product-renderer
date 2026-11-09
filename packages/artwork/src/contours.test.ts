import { describe, expect, it } from 'vitest';
import { traceContours } from './contours.js';
import type { Gray } from './sdf.js';

/**
 * Outlines are measured against shapes whose answer is known: a square's outline has a known
 * perimeter, a ring has two of them, and an empty mask has none.
 */

function mask(width: number, height: number, inside: (x: number, y: number) => boolean): Gray {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = inside(x, y) ? 255 : 0;
  }
  return { width, height, data };
}

const perimeter = (points: [number, number][]): number => {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
};

describe('traceContours', () => {
  const mmPerPx = 0.1;

  it('finds nothing in an empty mask', () => {
    expect(traceContours(mask(20, 20, () => false), mmPerPx)).toEqual([]);
  });

  it('traces a square, closed, at about its real perimeter', () => {
    // 20 px square in a 40 px field: 2 mm on a side at 0.1 mm per pixel.
    const square = mask(40, 40, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30);
    const contours = traceContours(square, mmPerPx);

    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
    expect(perimeter(contours[0]!.points)).toBeCloseTo(8, 0);
  });

  it('finds the hole as well as the outside', () => {
    const ring = mask(60, 60, (x, y) => {
      const r = Math.hypot(x - 30, y - 30);
      return r < 25 && r > 12;
    });

    const contours = traceContours(ring, mmPerPx);
    expect(contours).toHaveLength(2);
    expect(contours.every((contour) => contour.closed)).toBe(true);

    // The outer ring is the longer of the two, by roughly the ratio of the radii.
    const lengths = contours.map((contour) => perimeter(contour.points)).sort((a, b) => b - a);
    expect(lengths[0]! / lengths[1]!).toBeCloseTo(25 / 12, 0);
  });

  it('separates two shapes rather than joining them', () => {
    const pair = mask(60, 30, (x, y) => y >= 8 && y < 22 && (x >= 5 && x < 20 ? true : x >= 40 && x < 55));

    expect(traceContours(pair, mmPerPx)).toHaveLength(2);
  });

  it('measures in millimetres, so a coarser raster gives the same outline', () => {
    const fine = traceContours(mask(80, 80, (x, y) => x >= 20 && x < 60 && y >= 20 && y < 60), 0.05);
    const coarse = traceContours(mask(40, 40, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30), 0.1);

    // Not identical — simplification cuts corners differently at each pitch — but the same
    // outline to within a percent, which is what "measured in millimetres" has to mean.
    const ratio = perimeter(fine[0]!.points) / perimeter(coarse[0]!.points);
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.02);
  });

  it('drops specks a person would never see', () => {
    const speckled = mask(40, 40, (x, y) => {
      if (x >= 10 && x < 30 && y >= 10 && y < 30) return true;
      return x === 2 && y === 2; // one stray pixel
    });

    // The 0.1 mm speck is below the default half-millimetre floor; the square is not.
    expect(traceContours(speckled, mmPerPx)).toHaveLength(1);
  });

  it('places the edge where the antialiasing says it is, not at the nearest pixel', () => {
    // A hard edge at x = 20 with a half-covered column at 19: the outline should land between.
    const soft = mask(40, 40, (x, y) => y >= 10 && y < 30 && x >= 20 && x < 30);
    for (let y = 10; y < 30; y++) soft.data[y * 40 + 19] = 128;

    const [contour] = traceContours(soft, 1);
    const leftEdge = Math.min(...contour!.points.map((point) => point[0]));
    expect(leftEdge).toBeGreaterThan(19);
    expect(leftEdge).toBeLessThan(20.5);
  });
});
