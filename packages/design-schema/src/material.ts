import { z } from 'zod';
import { HexColor, Key } from './primitives.js';

export const TextureRef = z.object({
  /** Storage-relative path inside the owning pack, or a library texture key. */
  path: z.string().min(1),
  colorSpace: z.enum(['srgb', 'linear']).default('linear'),
});

/**
 * How a surface reads to a person holding it (F-MAT-03).
 *
 * Deliberately *not* a second set of shading numbers. `base` stays authoritative for both renderers
 * — a finish that set roughness would be a second source of truth, and the two would drift. This is
 * the axis a customer actually shops on: they ask for a soft-touch closure, not for sheen 0.4.
 *
 * Orthogonal to `family`, which says what the thing is made of. Matte paperboard and matte
 * polypropylene share a finish and nothing else; gloss and matte polypropylene share a material and
 * look nothing alike. Both axes are needed because packs filter on both.
 */
export const FINISH_FAMILIES = [
  'gloss',
  'matte',
  'satin',
  'soft-touch',
  'metallic',
  'pearlescent',
] as const;

export const FinishFamily = z.enum(FINISH_FAMILIES);
export type FinishFamily = z.infer<typeof FinishFamily>;

/**
 * The finish a set of PBR numbers already describes.
 *
 * Used two ways: as the finish of a material that did not declare one, so packs written before this
 * existed keep working; and to check a declared finish against its own numbers, because a material
 * labelled gloss and shaded matte misleads exactly the person the label is for.
 *
 * The thresholds are a reading of the numbers, not physics. They are here rather than in a comment
 * so that "does this look like satin" has one answer everything agrees on.
 */
export function finishFor(base: { roughness: number; metallic: number; clearcoat: number; sheen: number }): FinishFamily {
  if (base.metallic >= 0.5) return 'metallic';
  // A coat over a sheen is what makes a pearl read as one: the coat gives the highlight, the sheen
  // gives the shift underneath it.
  if (base.clearcoat >= 0.3 && base.sheen >= 0.2) return 'pearlescent';
  // Velvety rather than shiny: the sheen lobe is what your fingers expect from soft-touch lacquer.
  if (base.sheen >= 0.3 && base.roughness >= 0.5) return 'soft-touch';
  if (base.roughness <= 0.2) return 'gloss';
  if (base.roughness <= 0.45) return 'satin';
  return 'matte';
}

/**
 * Renderer-neutral PBR description. `base` is authoritative for both the three.js preview and the
 * Cycles render; `mapping` may only refine renderer-specific detail, never contradict `base`.
 */
export const MaterialDefinition = z.object({
  key: Key,
  name: z.string().min(1),
  version: z.number().int().positive().default(1),
  /**
   * What the part is made of (F-MAT-01, F-MAT-03).
   *
   * NOTE: this is a *material* family, not the finish family the acceptance for F-MAT-03 names
   * (gloss, matte, satin, soft-touch, metallic, pearlescent). Sheen is currently expressed by
   * shipping separate materials — `pp-matte` and `pp-gloss` — rather than as an axis anything can
   * select or filter on.
   */
  family: z.enum(['plastic', 'metal', 'paperboard', 'glass', 'ink', 'foil', 'coating']),
  /**
   * How it reads (F-MAT-03). Optional: a material that does not say gets the finish its own numbers
   * describe, so packs written before this existed keep working. Read it through `finishOf`.
   */
  finish: FinishFamily.optional(),
  colorizable: z.boolean().default(true),

  base: z.object({
    baseColorHex: HexColor.default('#cccccc'),
    roughness: z.number().min(0).max(1).default(0.4),
    metallic: z.number().min(0).max(1).default(0),
    ior: z.number().min(1).max(3).default(1.5),
    specular: z.number().min(0).max(1).default(0.5),
    clearcoat: z.number().min(0).max(1).default(0),
    clearcoatRoughness: z.number().min(0).max(1).default(0.05),
    sheen: z.number().min(0).max(1).default(0),
    transmission: z.number().min(0).max(1).default(0),
    thicknessMm: z.number().min(0).default(0),
    attenuationColorHex: HexColor.optional(),
    attenuationDistanceMm: z.number().positive().optional(),
    emissiveHex: HexColor.optional(),
    emissiveStrength: z.number().min(0).default(0),
  }),

  maps: z
    .object({
      baseColor: TextureRef.optional(),
      roughness: TextureRef.optional(),
      metallic: TextureRef.optional(),
      normal: TextureRef.optional(),
      ao: TextureRef.optional(),
      height: TextureRef.optional(),
      tilingMm: z.number().positive().default(50),
    })
    .default({ tilingMm: 50 }),

  mapping: z
    .object({
      three: z.record(z.string(), z.unknown()).default({}),
      cycles: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ three: {}, cycles: {} }),
});

export type MaterialDefinition = z.infer<typeof MaterialDefinition>;

/** A material's finish: what it declared, or what its numbers say when it declared nothing. */
export const finishOf = (material: Pick<MaterialDefinition, 'finish' | 'base'>): FinishFamily =>
  material.finish ?? finishFor(material.base);
export type TextureRef = z.infer<typeof TextureRef>;

/** Current product finishes; glossy retains the authored pearlescent shading. */
export const PP_MATERIALS: MaterialDefinition[] = [
  {
    key: 'pp-matte',
    name: 'Matte',
    family: 'plastic',
    finish: 'matte',
    colorizable: true,
    base: {
      baseColorHex: '#1b4d3e',
      roughness: 0.62,
      metallic: 0,
      ior: 1.49,
      specular: 0.45
    }
  },
  {
    key: 'pp-gloss',
    name: 'Glossy',
    family: 'plastic',
    finish: 'pearlescent',
    colorizable: true,
    base: {
      baseColorHex: '#dfe4ea',
      roughness: 0.28,
      metallic: 0,
      ior: 1.49,
      specular: 0.55,
      clearcoat: 0.55,
      clearcoatRoughness: 0.1,
      sheen: 0.35
    }
  }
].map((definition) => MaterialDefinition.parse(definition));
