import type { NormalizedArtwork } from '@pr/svg';
import { flattenSegments, polygonBounds, type Polygon } from './flatten.js';
import { rasterizeCoverage, type CoverageMask, type FillRule } from './scanline.js';
import { strokeToPolygons } from './stroke.js';

/**
 * Normalised artwork to a coverage mask, at a chosen physical resolution.
 *
 * The mask is cropped to the artwork's own content with a small margin, so the distance field has
 * room to fall off and the placement's natural size means the ink, not the document's canvas.
 */

export interface RasterizeArtworkOptions {
  /** Physical size of one output pixel. Chosen by the pipeline from the finest bevel to resolve. */
  mmPerPx: number;
  /** Blank pixels kept around the artwork so the distance field can fall off. */
  paddingPx?: number;
  fillRule?: FillRule;
  samplesPerPixel?: number;
  maxSidePx?: number;
}

export interface RasterizedArtwork {
  mask: CoverageMask;
  mmPerPx: number;
  /** Size of the inked content, in millimetres — the artwork's real dimensions. */
  contentSizeMm: { w: number; h: number };
  paddingPx: number;
}

export function rasterizeArtwork(
  artwork: NormalizedArtwork,
  options: RasterizeArtworkOptions,
): RasterizedArtwork | null {
  const padding = options.paddingPx ?? 8;
  const maxSide = options.maxSidePx ?? 4096;
  const unitsPerMm = artwork.unitsPerMm || 1;

  // Flatten first: the tolerance is a third of an output pixel, expressed in user units.
  const pxPerUnit = 1 / (unitsPerMm * options.mmPerPx);
  const tolerance = 0.33 / pxPerUnit;

  const filled: Polygon[] = [];
  for (const path of artwork.paths) {
    const polylines = flattenSegments(path.segments, { toleranceUnits: tolerance });
    if (path.fill) filled.push(...polylines);
    if (path.stroke && path.strokeWidth > 0) {
      for (const polyline of polylines) {
        filled.push(...strokeToPolygons(polyline, { width: path.strokeWidth }));
      }
    }
  }

  const bounds = polygonBounds(filled);
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;

  let scale = pxPerUnit;
  let width = Math.ceil(bounds.w * scale) + padding * 2;
  let height = Math.ceil(bounds.h * scale) + padding * 2;

  // Very large artwork is resolved at a coarser pitch rather than refused; the report already
  // carries the real dimensions, and the caller learns the pitch actually used. The cap applies to
  // the finished image, so the padding has to come out of the budget first.
  const available = Math.max(16, maxSide - padding * 2);
  const contentSide = Math.max(width, height) - padding * 2;
  if (contentSide > available) {
    scale *= available / contentSide;
    width = Math.ceil(bounds.w * scale) + padding * 2;
    height = Math.ceil(bounds.h * scale) + padding * 2;
  }

  const placed = filled.map((polygon) =>
    polygon.map(([x, y]) => [
      (x - bounds.x) * scale + padding,
      (y - bounds.y) * scale + padding,
    ] as const),
  );

  const mask = rasterizeCoverage(placed as Polygon[], {
    width,
    height,
    ...(options.fillRule ? { fillRule: options.fillRule } : {}),
    ...(options.samplesPerPixel ? { samplesPerPixel: options.samplesPerPixel } : {}),
  });

  const mmPerPx = 1 / (scale * unitsPerMm);
  return {
    mask,
    mmPerPx,
    contentSizeMm: { w: bounds.w / unitsPerMm, h: bounds.h / unitsPerMm },
    paddingPx: padding,
  };
}

/**
 * Resolution policy from docs/14-artwork-pipeline.md: the draft wall of the shallowest supported
 * relief must be several pixels wide, or emboss edges alias.
 */
export function choosePitchMm(longestSideMm: number, minDepthMm = 0.1, maxBevelDeg = 60): number {
  const wallMm = minDepthMm / Math.tan((maxBevelDeg * Math.PI) / 180);
  const ideal = wallMm / 4;
  const px = longestSideMm / ideal;
  if (px < 512) return longestSideMm / 512;
  if (px > 4096) return longestSideMm / 4096;
  return ideal;
}
