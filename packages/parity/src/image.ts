import { decodePng } from '@pr/artwork/png';
import type { Gray } from './ssim.js';
import type { RenderImage } from './compare.js';

/**
 * Getting the two images into one comparable shape.
 *
 * A preview arrives as a browser screenshot — 8-bit RGBA, always — and a render arrives as whatever
 * the job asked for, which may be 16-bit and may have no alpha at all. Rather than restrict the
 * harness to the formats that happen to match, both are widened to 8-bit RGBA here.
 */
export function rgbaFromPng(bytes: Uint8Array): RenderImage {
  const png = decodePng(bytes);
  const { width, height, channels, data } = png;
  const max = png.bitDepth === 16 ? 65535 : 255;
  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const at = (channel: number) => Math.round((Number(data[i * channels + channel] ?? max) / max) * 255);

    // Grey (1) and grey+alpha (2) put luminance in one channel; colour (3, 4) has all three.
    const r = at(0);
    const g = channels >= 3 ? at(1) : r;
    const b = channels >= 3 ? at(2) : r;
    const alpha = channels === 2 ? at(1) : channels === 4 ? at(3) : 255;

    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = alpha;
  }

  return { rgba, width, height };
}

/**
 * A difference map as bytes something can open.
 *
 * Inverted, so the image reads the way a person expects: white is agreement, and the dark patches
 * are where the two renderers disagree.
 */
export function grayToBytes(image: Gray, { invert = true }: { invert?: boolean } = {}): Uint8Array {
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const value = Math.min(1, Math.max(0, image.data[i]!));
    out[i] = Math.round((invert ? 1 - value : value) * 255);
  }
  return out;
}
