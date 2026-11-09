import type { Transform } from '@pr/design-schema';
import type { ZoneExtent } from '@pr/placement';

/**
 * Composites the placements of one zone into a zone-space texture.
 *
 * This is the 2D-canvas cousin of the GPU composite pass in docs/16-preview-engine.md: the texture
 * is addressed in zone millimetres, so the 3D preview and the 2D face view are showing the same
 * pixels placed by the same transform.
 */

export interface ZoneTextureOptions {
  zone: ZoneExtent;
  transform: Transform;
  artwork: HTMLCanvasElement | null;
  /** Texels per millimetre; 24 gives a 30 mm face a 720 px texture. */
  texelsPerMm?: number;
  maxSizePx?: number;
  /** Colour to clear to before compositing. Height layers clear to "zero relief", not transparent. */
  clearStyle?: string;
}

/** Millimetres covered by one texel of a zone texture — the shader needs this to differentiate. */
export function zoneTexelSizeMm(
  zone: ZoneExtent,
  canvas: HTMLCanvasElement,
): { x: number; y: number } {
  return { x: zone.w / Math.max(1, canvas.width), y: zone.h / Math.max(1, canvas.height) };
}

export function drawZoneTexture(
  canvas: HTMLCanvasElement,
  options: ZoneTextureOptions,
): HTMLCanvasElement {
  const { zone, transform, artwork, texelsPerMm = 24, maxSizePx = 2048 } = options;
  const scale = Math.min(texelsPerMm, maxSizePx / Math.max(zone.w, zone.h));
  const width = Math.max(1, Math.round(zone.w * scale));
  const height = Math.max(1, Math.round(zone.h * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, width, height);
  if (options.clearStyle) {
    ctx.fillStyle = options.clearStyle;
    ctx.fillRect(0, 0, width, height);
  }
  if (!artwork) return canvas;

  ctx.save();
  // Zone space is +y up with the origin at the centre; texture space is +y down from the corner.
  ctx.translate(width / 2 + transform.offsetMm.x * scale, height / 2 - transform.offsetMm.y * scale);
  ctx.rotate((-transform.rotationDeg * Math.PI) / 180);
  ctx.scale(
    ((transform.sizeMm.w * scale) / artwork.width) * (transform.flipX ? -1 : 1),
    ((transform.sizeMm.h * scale) / artwork.height) * (transform.flipY ? -1 : 1),
  );
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(artwork, -artwork.width / 2, -artwork.height / 2);
  ctx.restore();

  return canvas;
}
