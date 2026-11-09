/** Colour lives in exactly one place so the preview and the path tracer cannot drift apart. */

export type LinearRgb = readonly [number, number, number];

export function hexToSrgb(hex: string): LinearRgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`invalid hex colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The sRGB electro-optical transfer function, matching three.js and Blender. */
export function srgbToLinearChannel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgbChannel(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function hexToLinear(hex: string): LinearRgb {
  const [r, g, b] = hexToSrgb(hex);
  return [srgbToLinearChannel(r), srgbToLinearChannel(g), srgbToLinearChannel(b)];
}

export function linearToHex(rgb: LinearRgb): string {
  const to255 = (c: number) =>
    Math.max(0, Math.min(255, Math.round(linearToSrgbChannel(c) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${to255(rgb[0])}${to255(rgb[1])}${to255(rgb[2])}`;
}
