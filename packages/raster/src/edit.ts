import {
  normalizeSvg,
  serializeNormalized,
  sanitizeSvg,
  type NormalizedArtwork,
  type NormalizedPath,
  type Segment,
} from '@pr/svg';
import { flattenSegments } from './flatten.js';
import { strokeToPolygons } from './stroke.js';

export interface ArtworkTransform {
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  flipX: boolean;
  flipY: boolean;
}

export function transformArtworkSvg(
  artwork: NormalizedArtwork,
  edit: ArtworkTransform,
  precision = 4,
): string {
  // Converting strokes to the rasteriser's filled area before stretching avoids scaling a
  // centreline differently from its stroke and changing the visible dimensions unpredictably.
  if (artwork.paths.some((path) => path.stroke && path.strokeWidth > 0)) {
    const paths: NormalizedPath[] = [];
    for (const path of artwork.paths) {
      if (path.fill) paths.push({ ...path, stroke: null, strokeWidth: 0 });
      if (!path.stroke || path.strokeWidth <= 0) continue;
      for (const line of flattenSegments(path.segments, {
        toleranceUnits: artwork.unitsPerMm * 0.001,
      })) {
        for (const polygon of strokeToPolygons(line, { width: path.strokeWidth })) {
          const segments: Segment[] = polygon.map(([x, y], index) => ({
            command: index === 0 ? 'M' : 'L',
            values: [x, y],
          }));
          segments.push({ command: 'Z', values: [] });
          paths.push({
            segments,
            fill: path.stroke,
            stroke: null,
            strokeWidth: 0,
            opacity: path.opacity,
            closed: true,
          });
        }
      }
    }
    artwork = normalizeSvg(sanitizeSvg(serializeNormalized({ ...artwork, paths })).root);
  }
  const bounds = artwork.contentBBox;
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) throw new Error('Artwork has no visible bounds.');
  if (
    ![edit.widthMm, edit.heightMm, edit.rotationDeg].every(Number.isFinite) ||
    edit.widthMm <= 0 ||
    edit.heightMm <= 0
  )
    throw new Error('Artwork dimensions must be positive.');

  const radians = (edit.rotationDeg * Math.PI) / 180;
  const scaleX = (edit.widthMm / bounds.w) * (edit.flipX ? -1 : 1);
  const scaleY = (edit.heightMm / bounds.h) * (edit.flipY ? -1 : 1);
  const a = Math.cos(radians) * scaleX;
  const b = Math.sin(radians) * scaleX;
  const c = -Math.sin(radians) * scaleY;
  const d = Math.cos(radians) * scaleY;
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  const matrix = `${a} ${b} ${c} ${d} ${-a * centerX - c * centerY} ${-b * centerX - d * centerY}`;

  // Flatten through the same normaliser as ingest so preview and saved geometry share transforms.
  const paths = serializeNormalized(artwork, precision)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');
  const transformed = normalizeSvg(
    sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1mm" height="1mm" viewBox="0 0 1 1">` +
        `<g transform="matrix(${matrix})">${paths}</g></svg>`,
    ).root,
  );
  const box = transformed.contentBBox;
  if (!box || box.w <= 0 || box.h <= 0) throw new Error('Artwork has no visible bounds.');
  return serializeNormalized(
    {
      ...transformed,
      viewBox: box,
      naturalSizeMm: { w: box.w, h: box.h },
      unitsPerMm: 1,
    },
    precision,
  );
}
