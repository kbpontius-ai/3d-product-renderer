import { ensureOrientation, type Point, type Polygon } from './flatten.js';

/**
 * Stroke to fill.
 *
 * Real logos carry strokes, and a relief is defined by filled area, so strokes must become area
 * before rasterising. This is the pragmatic construction — a quad per segment plus a disc at every
 * join and cap — which the nonzero fill rule unions for free. It is not a general offsetting
 * algorithm (no miter joins, no self-intersection resolution), and the artwork report says so by
 * measuring stroke widths and warning when they are near the process limit.
 */

export type LineCap = 'butt' | 'round' | 'square';

export interface StrokeOptions {
  width: number;
  cap?: LineCap;
  /** Segments used to approximate each round join or cap. */
  arcSegments?: number;
}

export function strokeToPolygons(polyline: Polygon, options: StrokeOptions): Polygon[] {
  const width = options.width;
  if (!(width > 0) || polyline.length < 2) return [];

  const half = width / 2;
  const cap = options.cap ?? 'round';
  const arcSegments = options.arcSegments ?? 12;
  const polygons: Polygon[] = [];

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-12) continue;

    const nx = (-dy / length) * half;
    const ny = (dx / length) * half;

    // Square caps extend the first and last segment by half a width.
    const extendStart = cap === 'square' && i === 0 ? half : 0;
    const extendEnd = cap === 'square' && i === polyline.length - 2 ? half : 0;
    const ux = dx / length;
    const uy = dy / length;

    const ax = a[0] - ux * extendStart;
    const ay = a[1] - uy * extendStart;
    const bx = b[0] + ux * extendEnd;
    const by = b[1] + uy * extendEnd;

    polygons.push([
      [ax + nx, ay + ny],
      [bx + nx, by + ny],
      [bx - nx, by - ny],
      [ax - nx, ay - ny],
    ]);
  }

  // Joins, and round caps at the ends.
  const joinAt = (point: Point) => polygons.push(disc(point, half, arcSegments));
  for (let i = 1; i < polyline.length - 1; i++) joinAt(polyline[i]!);
  if (cap === 'round') {
    joinAt(polyline[0]!);
    joinAt(polyline[polyline.length - 1]!);
  }

  // Every piece of a stroke must union, never cancel, so they all wind the same way.
  return ensureOrientation(polygons);
}

export function disc(center: Point, radius: number, segments: number): Polygon {
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]);
  }
  return points;
}
