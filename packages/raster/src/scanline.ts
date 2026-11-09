import type { Polygon } from './flatten.js';

/**
 * Deterministic coverage rasteriser.
 *
 * Vertical supersampling with analytic horizontal coverage: each sub-scanline contributes exact
 * fractional coverage to the pixels its spans cross, so edges are smooth without the cost of full
 * NxN supersampling.
 *
 * Owning this — rather than delegating to a browser canvas or a native library — is what lets the
 * preview and the render worker produce byte-identical masks from the same artwork
 * (docs/14-artwork-pipeline.md, "Deterministic").
 */

export type FillRule = 'nonzero' | 'evenodd';

export interface RasterizeOptions {
  width: number;
  height: number;
  fillRule?: FillRule;
  /** Sub-scanlines per pixel row. 8 is visually indistinguishable from 16 at our resolutions. */
  samplesPerPixel?: number;
}

export interface CoverageMask {
  data: Uint8Array;
  width: number;
  height: number;
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** +1 when the edge runs downward, -1 upward; the sign that makes nonzero winding work. */
  direction: number;
}

export function rasterizeCoverage(polygons: Polygon[], options: RasterizeOptions): CoverageMask {
  const { width, height } = options;
  const fillRule = options.fillRule ?? 'nonzero';
  const samples = Math.max(1, options.samplesPerPixel ?? 8);

  const data = new Uint8Array(width * height);
  const edges = buildEdges(polygons);
  if (edges.length === 0) return { data, width, height };

  const accumulator = new Float32Array(width);
  const crossings: { x: number; direction: number }[] = [];
  const sampleWeight = 1 / samples;

  for (let row = 0; row < height; row++) {
    accumulator.fill(0);

    for (let s = 0; s < samples; s++) {
      const y = row + (s + 0.5) / samples;
      crossings.length = 0;

      for (const edge of edges) {
        // Half-open interval in y: a vertex shared by two edges is counted exactly once.
        if (y < Math.min(edge.y0, edge.y1) || y >= Math.max(edge.y0, edge.y1)) continue;
        const t = (y - edge.y0) / (edge.y1 - edge.y0);
        crossings.push({ x: edge.x0 + t * (edge.x1 - edge.x0), direction: edge.direction });
      }

      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x);

      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i++) {
        winding += fillRule === 'nonzero' ? crossings[i]!.direction : 1;
        const inside = fillRule === 'nonzero' ? winding !== 0 : winding % 2 !== 0;
        if (!inside) continue;
        addSpan(accumulator, crossings[i]!.x, crossings[i + 1]!.x, sampleWeight, width);
      }
    }

    const offset = row * width;
    for (let x = 0; x < width; x++) {
      const coverage = accumulator[x]!;
      if (coverage <= 0) continue;
      data[offset + x] = Math.min(255, Math.round(coverage * 255));
    }
  }

  return { data, width, height };
}

/** Adds a horizontal span's exact per-pixel coverage to the row accumulator. */
function addSpan(
  accumulator: Float32Array,
  xStart: number,
  xEnd: number,
  weight: number,
  width: number,
): void {
  const from = Math.max(0, xStart);
  const to = Math.min(width, xEnd);
  if (to <= from) return;

  const first = Math.floor(from);
  const last = Math.min(width - 1, Math.ceil(to) - 1);

  if (first === last) {
    accumulator[first]! += (to - from) * weight;
    return;
  }

  accumulator[first]! += (first + 1 - from) * weight;
  for (let x = first + 1; x < last; x++) accumulator[x]! += weight;
  accumulator[last]! += (to - last) * weight;
}

function buildEdges(polygons: Polygon[]): Edge[] {
  const edges: Edge[] = [];

  for (const polygon of polygons) {
    if (polygon.length < 2) continue;

    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!;
      // Implicitly close every polygon: an unclosed fill is a designer's oversight, not a hole.
      const b = polygon[(i + 1) % polygon.length]!;
      if (a[1] === b[1]) continue; // horizontal edges never cross a scanline

      edges.push(
        a[1] < b[1]
          ? { x0: a[0], y0: a[1], x1: b[0], y1: b[1], direction: 1 }
          : { x0: b[0], y0: b[1], x1: a[0], y1: a[1], direction: -1 },
      );
    }
  }

  return edges;
}

/** Total ink coverage as a fraction of the image, used for the artwork report. */
export function coverageFraction(mask: CoverageMask): number {
  let total = 0;
  for (const value of mask.data) total += value;
  return total / (255 * mask.data.length);
}
