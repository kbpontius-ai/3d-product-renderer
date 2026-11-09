import type { MaterialAssignment, MaterialDefinition } from '@pr/design-schema';
import { hexToLinear, type LinearRgb } from './color.js';

/**
 * One neutral material definition, two renderer mappings.
 *
 * `base` is authoritative; a renderer mapping may only refine detail it alone understands, never
 * contradict the shared numbers. The parity suite (docs/20-testing-ci.md) checks this empirically;
 * the tests here check it structurally.
 */

export interface EffectiveMaterial {
  key: string;
  /** sRGB hex after applying a colour assignment, if the material accepts one. */
  colorHex: string;
  roughness: number;
  metallic: number;
  ior: number;
  specular: number;
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  transmission: number;
  thicknessMm: number;
  emissiveHex?: string;
  emissiveStrength: number;
  attenuationColorHex?: string;
  attenuationDistanceMm?: number;
}

/** Resolves a definition plus the design's assignment into the numbers both renderers consume. */
export function effectiveMaterial(
  def: MaterialDefinition,
  assignment?: MaterialAssignment,
): EffectiveMaterial {
  const colorHex =
    def.colorizable && assignment?.colorHex ? assignment.colorHex : def.base.baseColorHex;

  return {
    key: def.key,
    colorHex,
    roughness: assignment?.overrides?.roughness ?? def.base.roughness,
    metallic: assignment?.overrides?.metallic ?? def.base.metallic,
    ior: def.base.ior,
    specular: def.base.specular,
    clearcoat: assignment?.overrides?.clearcoat ?? def.base.clearcoat,
    clearcoatRoughness: def.base.clearcoatRoughness,
    sheen: def.base.sheen,
    transmission: def.base.transmission,
    thicknessMm: def.base.thicknessMm,
    ...(def.base.emissiveHex ? { emissiveHex: def.base.emissiveHex } : {}),
    emissiveStrength: def.base.emissiveStrength,
    ...(def.base.attenuationColorHex ? { attenuationColorHex: def.base.attenuationColorHex } : {}),
    ...(def.base.attenuationDistanceMm === undefined
      ? {}
      : { attenuationDistanceMm: def.base.attenuationDistanceMm }),
  };
}

/** Constructor parameters for three.js MeshPhysicalMaterial (colours stay sRGB; three converts). */
export interface ThreeMaterialParams {
  color: string;
  roughness: number;
  metalness: number;
  ior: number;
  specularIntensity: number;
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  transmission: number;
  thickness: number;
  transparent: boolean;
  emissive?: string;
  emissiveIntensity?: number;
  attenuationColor?: string;
  attenuationDistance?: number;
}

export function toThreeParams(
  def: MaterialDefinition,
  assignment?: MaterialAssignment,
): ThreeMaterialParams {
  const m = effectiveMaterial(def, assignment);
  return {
    color: m.colorHex,
    roughness: m.roughness,
    metalness: m.metallic,
    ior: m.ior,
    specularIntensity: m.specular,
    clearcoat: m.clearcoat,
    clearcoatRoughness: m.clearcoatRoughness,
    sheen: m.sheen,
    transmission: m.transmission,
    thickness: m.thicknessMm, // three.js scene units are millimetres, matching the packs
    transparent: m.transmission > 0,
    ...(m.emissiveHex ? { emissive: m.emissiveHex, emissiveIntensity: m.emissiveStrength } : {}),
    ...(m.attenuationColorHex ? { attenuationColor: m.attenuationColorHex } : {}),
    ...(m.attenuationDistanceMm === undefined
      ? {}
      : { attenuationDistance: m.attenuationDistanceMm }),
    ...(def.mapping.three as Record<string, never>),
  };
}

/** Input socket values for Cycles' Principled BSDF (linear colours, metres). */
export interface CyclesPrincipledParams {
  base_color: LinearRgb;
  roughness: number;
  metallic: number;
  ior: number;
  specular_ior_level: number;
  coat_weight: number;
  coat_roughness: number;
  sheen_weight: number;
  transmission_weight: number;
  emission_color?: LinearRgb;
  emission_strength: number;
  /** Blender works in metres; packs are authored in millimetres. */
  thickness_m: number;
  attenuation_color?: LinearRgb;
  attenuation_distance_m?: number;
}

export function toCyclesParams(
  def: MaterialDefinition,
  assignment?: MaterialAssignment,
): CyclesPrincipledParams {
  const m = effectiveMaterial(def, assignment);
  return {
    base_color: hexToLinear(m.colorHex),
    roughness: m.roughness,
    metallic: m.metallic,
    ior: m.ior,
    specular_ior_level: m.specular,
    coat_weight: m.clearcoat,
    coat_roughness: m.clearcoatRoughness,
    sheen_weight: m.sheen,
    transmission_weight: m.transmission,
    ...(m.emissiveHex ? { emission_color: hexToLinear(m.emissiveHex) } : {}),
    emission_strength: m.emissiveStrength,
    thickness_m: m.thicknessMm / 1000,
    ...(m.attenuationColorHex ? { attenuation_color: hexToLinear(m.attenuationColorHex) } : {}),
    ...(m.attenuationDistanceMm === undefined
      ? {}
      : { attenuation_distance_m: m.attenuationDistanceMm / 1000 }),
    ...(def.mapping.cycles as Record<string, never>),
  };
}

/** Quantities that must be identical in both renderers; the parity test asserts on exactly these. */
export const SHARED_MATERIAL_FIELDS = [
  'roughness',
  'metallic',
  'ior',
  'specular',
  'clearcoat',
  'clearcoatRoughness',
  'sheen',
  'transmission',
] as const;
