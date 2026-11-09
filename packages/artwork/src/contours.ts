import type { Gray } from './sdf.js';

/**
 * Outlines traced from the coverage mask (F-ART-05).
 *
 * The mask says which pixels are inside the artwork; a contour says where its edge runs, in
 * millimetres. That is what the face view needs to draw an outline you can see against a busy
 * product, what a clearance measurement is taken from, and what a spec sheet will dimension in v2.
 *
 * Marching squares on the half-coverage isoline, with linear interpolation along each cell edge, so
 * the outline sits where the antialiased edge actually is rather than on the nearest pixel corner.
 */

export interface Contour {
  /** Millimetres, in the same frame as the mask: origin top-left, +x right, +y down. */
  points: [number, number][];
  closed: boolean;
}

export interface ContourOptions {
  /** Coverage at which the edge is considered to be. Half is the antialiased midpoint. */
  threshold?: number;
  /**
   * Drop segments shorter than this many millimetres of total length.
   *
   * Rasterising a logo leaves specks — a stray antialiased pixel at a corner, a one-pixel island
   * inside a counter — and a spec sheet listing forty outlines nobody can see is worse than one
   * listing four.
   */
  minLengthMm?: number;
  /** Collapse points closer together than this, in millimetres. */
  simplifyMm?: number;
}

export function traceContours(mask: Gray, mmPerPx: number, options: ContourOptions = {}): Contour[] {
  const threshold = (options.threshold ?? 0.5) * 255;
  const minLengthMm = options.minLengthMm ?? 0.5;
  const simplifyMm = options.simplifyMm ?? mmPerPx * 0.75;

  const segments = marchingSquares(mask, threshold, mmPerPx);
  const contours = stitch(segments, mmPerPx * 0.51);

  return contours
    .map((contour) => ({ ...contour, points: simplify(contour.points, simplifyMm) }))
    .filter((contour) => contour.points.length >= 3 && lengthOf(contour.points) >= minLengthMm);
}

type Segment = [[number, number], [number, number]];

function marchingSquares(mask: Gray, threshold: number, mmPerPx: number): Segment[] {
  const { width, height, data } = mask;
  const segments: Segment[] = [];
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (data[y * width + x] ?? 0);

  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      // Corner samples of one cell, clockwise from top-left.
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);

      const index =
        (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0) | (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0);
      if (index === 0 || index === 15) continue;

      // Where the isoline crosses each edge, interpolated between the two corner values.
      const top = (): [number, number] => [(x + lerp(tl, tr, threshold) + 0.5) * mmPerPx, (y + 0.5) * mmPerPx];
      const right = (): [number, number] => [(x + 1.5) * mmPerPx, (y + lerp(tr, br, threshold) + 0.5) * mmPerPx];
      const bottom = (): [number, number] => [(x + lerp(bl, br, threshold) + 0.5) * mmPerPx, (y + 1.5) * mmPerPx];
      const left = (): [number, number] => [(x + 0.5) * mmPerPx, (y + lerp(tl, bl, threshold) + 0.5) * mmPerPx];

      switch (index) {
        case 1:
        case 14:
          segments.push([left(), bottom()]);
          break;
        case 2:
        case 13:
          segments.push([bottom(), right()]);
          break;
        case 3:
        case 12:
          segments.push([left(), right()]);
          break;
        case 4:
        case 11:
          segments.push([top(), right()]);
          break;
        case 6:
        case 9:
          segments.push([top(), bottom()]);
          break;
        case 7:
        case 8:
          segments.push([left(), top()]);
          break;
        // The ambiguous saddles: both diagonals cross, and either pairing is defensible. Taking
        // both segments keeps the outline closed, which is what everything downstream needs.
        case 5:
          segments.push([left(), top()], [bottom(), right()]);
          break;
        case 10:
          segments.push([top(), right()], [left(), bottom()]);
          break;
      }
    }
  }

  return segments;
}

/** Fraction along an edge where the threshold sits, given the values at its two ends. */
function lerp(a: number, b: number, threshold: number): number {
  const span = b - a;
  if (Math.abs(span) < 1e-6) return 0.5;
  return Math.min(1, Math.max(0, (threshold - a) / span));
}

/** Joins loose segments end to end into paths, closing the ones that come back on themselves. */
function stitch(segments: Segment[], tolerance: number): Contour[] {
  const remaining = new Set(segments.map((_, index) => index));
  const key = (point: [number, number]): string =>
    `${Math.round(point[0] / tolerance)}:${Math.round(point[1] / tolerance)}`;

  const startsAt = new Map<string, number[]>();
  for (const [index, segment] of segments.entries()) {
    for (const end of [segment[0], segment[1]]) {
      const bucket = startsAt.get(key(end)) ?? [];
      bucket.push(index);
      startsAt.set(key(end), bucket);
    }
  }

  const contours: Contour[] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as number;
    remaining.delete(first);

    const points: [number, number][] = [segments[first]![0], segments[first]![1]];
    let extended = true;

    while (extended) {
      extended = false;
      const tail = points[points.length - 1]!;

      for (const candidate of startsAt.get(key(tail)) ?? []) {
        if (!remaining.has(candidate)) continue;
        const [a, b] = segments[candidate]!;
        const next = key(a) === key(tail) ? b : a;
        points.push(next);
        remaining.delete(candidate);
        extended = true;
        break;
      }
    }

    const closed = key(points[0]!) === key(points[points.length - 1]!);
    if (closed) points.pop();
    contours.push({ points, closed });
  }

  return contours;
}

/** Drops points that add nothing: consecutive samples closer together than the tolerance. */
function simplify(points: [number, number][], toleranceMm: number): [number, number][] {
  if (points.length < 3 || toleranceMm <= 0) return points;

  const out: [number, number][] = [points[0]!];
  for (const point of points.slice(1)) {
    const last = out[out.length - 1]!;
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= toleranceMm) out.push(point);
  }
  return out;
}

function lengthOf(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return total;
}
