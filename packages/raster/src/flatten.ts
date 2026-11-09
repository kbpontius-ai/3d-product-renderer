import type { Matrix, Segment } from '@pr/svg';
import { applyMatrix } from '@pr/svg';

/**
 * Curves to polylines.
 *
 * Adaptive subdivision by flatness, so a 2 mm bevel and a 200 mm panel edge each get the number of
 * points they actually need. The tolerance is expressed in output pixels, which is the only scale
 * that matters for a rasteriser.
 */

export type Point = readonly [number, number];
export type Polygon = Point[];

export interface FlattenOptions {
  /** Maximum deviation from the true curve, in the same units as the incoming geometry. */
  toleranceUnits?: number;
  /** Optional transform applied to every point (user units to pixels, typically). */
  matrix?: Matrix;
  maxPoints?: number;
  strictTolerance?: boolean;
}

export function flattenSegments(segments: Segment[], options: FlattenOptions = {}): Polygon[] {
  const tolerance = options.toleranceUnits ?? 0.1;
  const matrix = options.matrix;
  const map = (x: number, y: number): Point => (matrix ? applyMatrix(matrix, x, y) : [x, y]);

  const polygons: Polygon[] = [];
  let current: Point[] = [];
  let start: Point | null = null;
  let cursor: Point = [0, 0];
  let flushedPoints = 0;

  const flush = () => {
    flushedPoints += current.length;
    if (options.maxPoints && flushedPoints > options.maxPoints)
      throw new Error('Curve flattening exceeds the point budget.');
    if (current.length >= 2) polygons.push(current);
    current = [];
  };

  for (const segment of segments) {
    switch (segment.command) {
      case 'M': {
        flush();
        cursor = map(segment.values[0], segment.values[1]);
        start = cursor;
        current = [cursor];
        break;
      }

      case 'L': {
        cursor = map(segment.values[0], segment.values[1]);
        current.push(cursor);
        break;
      }

      case 'C': {
        const [x1, y1, x2, y2, x, y] = segment.values;
        const c1 = map(x1, y1);
        const c2 = map(x2, y2);
        const end = map(x, y);
        subdivideCubic(
          cursor,
          c1,
          c2,
          end,
          tolerance,
          current,
          0,
          options.strictTolerance,
          options.maxPoints ? options.maxPoints - flushedPoints : undefined,
        );
        cursor = end;
        break;
      }

      case 'Z': {
        if (start && current.length > 0) {
          current.push(start);
          cursor = start;
        }
        flush();
        break;
      }
    }
    if (options.maxPoints && flushedPoints + current.length > options.maxPoints)
      throw new Error('Curve flattening exceeds the point budget.');
  }

  flush();
  return polygons;
}

/** Recursive flatness subdivision; the classic control-polygon distance test. */
function subdivideCubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  tolerance: number,
  out: Point[],
  depth = 0,
  strict = false,
  maxPoints?: number,
): void {
  const flat = strict
    ? isStrictlyFlat(p0, p1, p2, p3, tolerance)
    : isFlat(p0, p1, p2, p3, tolerance);
  if (strict && depth > 16 && !flat)
    throw new Error('A curve cannot be flattened within the required tolerance.');
  if (depth > 16 || flat) {
    if (maxPoints && out.length >= maxPoints)
      throw new Error('Curve flattening exceeds the point budget.');
    out.push(p3);
    return;
  }

  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const middle = mid(p012, p123);

  subdivideCubic(p0, p01, p012, middle, tolerance, out, depth + 1, strict, maxPoints);
  subdivideCubic(middle, p123, p23, p3, tolerance, out, depth + 1, strict, maxPoints);
}

function isStrictlyFlat(p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number): boolean {
  const x = p3[0] - p0[0],
    y = p3[1] - p0[1],
    length = x * x + y * y;
  const distance = (p: Point): number => {
    const t = length
      ? Math.min(1, Math.max(0, ((p[0] - p0[0]) * x + (p[1] - p0[1]) * y) / length))
      : 0;
    return Math.hypot(p[0] - p0[0] - t * x, p[1] - p0[1] - t * y);
  };
  return distance(p1) <= tolerance && distance(p2) <= tolerance;
}

function isFlat(p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number): boolean {
  const ux = 3 * p1[0] - 2 * p0[0] - p3[0];
  const uy = 3 * p1[1] - 2 * p0[1] - p3[1];
  const vx = 3 * p2[0] - p0[0] - 2 * p3[0];
  const vy = 3 * p2[1] - p0[1] - 2 * p3[1];
  const max = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy);
  return max <= 16 * tolerance * tolerance;
}

/** Signed area; positive is counter-clockwise in a y-down raster space. */
export function signedArea(polygon: Polygon): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/**
 * Forces every polygon to wind the same way.
 *
 * Under the nonzero rule, overlapping shapes that wind oppositely cancel — which is how holes are
 * made, and also how a stroke's own quads and joins would eat each other. Anything meant to union
 * must therefore agree on direction.
 */
export function ensureOrientation(polygons: Polygon[], counterClockwise = true): Polygon[] {
  return polygons.map((polygon) => {
    const area = signedArea(polygon);
    const isCcw = area > 0;
    return isCcw === counterClockwise ? polygon : [...polygon].reverse();
  });
}

export function polygonBounds(
  polygons: Polygon[],
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const polygon of polygons) {
    for (const [x, y] of polygon) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
