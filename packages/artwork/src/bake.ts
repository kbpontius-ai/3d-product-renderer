import { heightMm, type FinishParams } from './profile.js';
import { encode16, type SignedDistanceField } from './sdf.js';

/**
 * Derived assets, shared by both renderers (F-ART-05).
 *
 * Baking turns an artwork's distance field plus a placement's finish parameters into the height
 * map the offline renderer displaces with. The preview does the same arithmetic per fragment in
 * GLSL instead of baking — same function, same result, which is what keeps WYSIWYG honest.
 */

/** Fixed encode range so the renderer decodes without carrying per-asset metadata. */
export const HEIGHT_ENCODE_RANGE_MM: readonly [number, number] = [-5, 5];

export function heightFieldMm(sdf: SignedDistanceField, params: FinishParams): Float32Array {
  const out = new Float32Array(sdf.data.length);
  for (let i = 0; i < out.length; i++) out[i] = heightMm(sdf.data[i]!, params);
  return out;
}

export interface BakedHeightMap {
  data: Uint16Array;
  width: number;
  height: number;
  rangeMm: readonly [number, number];
  /** Peak relief actually achieved, which is below `depthMm` for features thinner than the wall. */
  peakMm: number;
}

export function bakeHeight16(
  sdf: SignedDistanceField,
  params: FinishParams,
  rangeMm: readonly [number, number] = HEIGHT_ENCODE_RANGE_MM,
): BakedHeightMap {
  const data = new Uint16Array(sdf.data.length);
  let peakMm = 0;

  for (let i = 0; i < data.length; i++) {
    const mm = heightMm(sdf.data[i]!, params);
    data[i] = encode16(mm, rangeMm);
    if (Math.abs(mm) > Math.abs(peakMm)) peakMm = mm;
  }

  return { data, width: sdf.width, height: sdf.height, rangeMm, peakMm };
}

/**
 * Coverage mask for printed finishes: 1 inside the artwork, 0 outside, feathered by one texel so
 * the ink edge is antialiased rather than stair-stepped.
 */
export function bakeInkCoverage8(sdf: SignedDistanceField, featherMm?: number): Uint8Array {
  const feather = featherMm ?? sdf.mmPerPx;
  const out = new Uint8Array(sdf.data.length);
  for (let i = 0; i < out.length; i++) {
    const t = (sdf.data[i]! + feather) / (2 * feather); // smooth across the edge
    out[i] = Math.round(Math.max(0, Math.min(1, t)) * 255);
  }
  return out;
}
