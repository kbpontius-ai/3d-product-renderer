import type { Finish, MaterialDefinition } from '@pr/design-schema';
import { hexToLinear, type LinearRgb } from './color.js';

/**
 * How the artwork's own region shades, in both renderers (F-MAT-05).
 *
 * The mark a design puts on a part is not shaded like the part. A foil is a mirror, a flat ink is
 * matte and opaque, a spot varnish is clear and glossy — which is the whole point of choosing one:
 * a matte closure with a gloss-varnished emboss is a real product, and it is two finishes on one
 * surface.
 *
 * The numbers come from the chosen material's own `base`, the same place the part's numbers come
 * from. They used to be two pairs of constants — 0.55/0 for print, 0.18/1 for relief — written into
 * the editor and into the Cycles scene builder separately. Those constants were `ink-black` and
 * `foil-gold` from the fixture pack, inlined: a stand-in for this lookup that held for exactly as
 * long as every pack shipped those two materials and no others.
 *
 * This lives beside `effectiveMaterial` for the reason `color.ts` gives about colour: shading
 * decided in one place cannot drift between the preview and the path tracer. Nothing is invented
 * here — a material is read.
 */

/**
 * What a mark was shaded with before any material was consulted.
 *
 * Kept rather than deleted with the code that used it, because a stored design can name an ink
 * material its pack no longer ships — a republished pack, a design restored from an old version —
 * and shading that the way it has always been shaded beats refusing to render it. `ResolvedInk`
 * reports which material it actually read, so a caller that wants to warn can tell.
 */
export const LEGACY_INK = {
  print: { roughness: 0.55, metallic: 0 },
  relief: { roughness: 0.18, metallic: 1 },
} as const;

export interface ResolvedInk {
  /** The material actually read, or null when the legacy numbers above stood in for one. */
  materialKey: string | null;
  /** sRGB hex of the mark. Meaningless where `tintStrength` is 0, but always populated. */
  colorHex: string;
  colorLinear: LinearRgb;
  roughness: number;
  metallic: number;
  /** 1 for relief; a printed mark may be laid down thin. */
  opacity: number;
  /**
   * How much of the mark's colour reaches the surface, 0 or 1.
   *
   * A spot varnish is the case this exists for: it covers the mark and changes how it catches the
   * light without changing its colour at all, which is the difference between "gloss this artwork"
   * and "paint this artwork white". A `coating` is clear unless the design tints it deliberately;
   * every other family paints.
   */
  tintStrength: number;
}

/**
 * The shading for one placement's mark, or null when the mark carries no ink.
 *
 * Null is a blind relief — depth in the part's own material, which is the default and the "same as
 * the part" case. It is expressed by the placement naming no ink material and no tint, so "no
 * choice was made" and "there is no ink" are one state rather than two that can disagree.
 */
export function inkShading(
  finish: Finish,
  materials: MaterialLookup,
): ResolvedInk | null {
  const key = finish.inkMaterialKey;
  const tint = finish.tintHex;

  if (finish.kind !== 'print' && key === undefined && tint === undefined) return null;

  const definition = key === undefined ? undefined : lookup(materials, key);
  const legacy = finish.kind === 'print' ? LEGACY_INK.print : LEGACY_INK.relief;

  // A clear coating stays clear unless somebody asked for a colour. Anything else — ink, foil,
  // paint — is the colour it is, and the placement's tint refines that rather than replacing the
  // decision to have one.
  const clear = tint === undefined && (definition?.family === 'coating' ||
    (finish.kind !== 'print' && definition?.family === 'plastic'));

  return {
    materialKey: definition?.key ?? null,
    colorHex: tint ?? definition?.base.baseColorHex ?? DEFAULT_INK_HEX,
    colorLinear: hexToLinear(tint ?? definition?.base.baseColorHex ?? DEFAULT_INK_HEX),
    roughness: definition?.base.roughness ?? legacy.roughness,
    metallic: definition?.base.metallic ?? legacy.metallic,
    opacity: finish.kind === 'print' ? finish.opacity : 1,
    tintStrength: clear ? 0 : 1,
  };
}

/** What an untinted print with no resolvable material has always been drawn in. */
const DEFAULT_INK_HEX = '#111111';

/** Both shapes the callers have to hand: the render spec builds a Map, the editor holds a record. */
export type MaterialLookup =
  | ReadonlyMap<string, MaterialDefinition>
  | Readonly<Record<string, MaterialDefinition>>;

function lookup(materials: MaterialLookup, key: string): MaterialDefinition | undefined {
  return materials instanceof Map ? materials.get(key) : (materials as Record<string, MaterialDefinition>)[key];
}
