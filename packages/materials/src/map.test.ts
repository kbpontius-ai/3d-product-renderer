import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MaterialDefinition, validatePack, type MaterialAssignment } from '@pr/design-schema';
import { hexToLinear, linearToHex, srgbToLinearChannel } from './color.js';
import {
  effectiveMaterial,
  SHARED_MATERIAL_FIELDS,
  toCyclesParams,
  toThreeParams,
} from './map.js';

const def = (over: Record<string, unknown> = {}) =>
  MaterialDefinition.parse({
    key: 'pp-matte',
    name: 'PP matte',
    family: 'plastic',
    base: { baseColorHex: '#1b4d3e', roughness: 0.62, metallic: 0, ior: 1.49, specular: 0.45 },
    ...over,
  });

const assignment = (over: Partial<MaterialAssignment> = {}): MaterialAssignment => ({
  materialKey: 'pp-matte',
  textureScale: 1,
  textureRotationDeg: 0,
  ...over,
});

function packMaterials(key: string) {
  const path = fileURLToPath(new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url));
  return validatePack(JSON.parse(readFileSync(path, 'utf8'))).manifest.materials;
}

describe('colour conversion', () => {
  it('round-trips hex through linear', () => {
    for (const hex of ['#000000', '#ffffff', '#1b4d3e', '#c9a227']) {
      expect(linearToHex(hexToLinear(hex))).toBe(hex);
    }
  });

  it('uses the sRGB transfer function, not a naive gamma', () => {
    expect(srgbToLinearChannel(0.5)).toBeCloseTo(0.21404114, 6);
    expect(srgbToLinearChannel(0.02)).toBeCloseTo(0.02 / 12.92, 9); // linear segment near black
  });

  it('rejects malformed colours instead of guessing', () => {
    expect(() => hexToLinear('rebeccapurple')).toThrow();
  });
});

describe('effectiveMaterial', () => {
  it('applies a colour assignment to a colorizable material', () => {
    expect(effectiveMaterial(def(), assignment({ colorHex: '#aa0000' })).colorHex).toBe('#aa0000');
  });

  it('ignores colour on a material that does not accept it', () => {
    const foil = def({ key: 'foil-gold', family: 'foil', colorizable: false, base: { baseColorHex: '#c9a227' } });
    expect(effectiveMaterial(foil, assignment({ colorHex: '#00ff00' })).colorHex).toBe('#c9a227');
  });

  it('applies bounded overrides', () => {
    const m = effectiveMaterial(def(), assignment({ overrides: { roughness: 0.1, metallic: 1 } }));
    expect(m.roughness).toBe(0.1);
    expect(m.metallic).toBe(1);
  });

  it('leaves untouched fields at their definition values', () => {
    expect(effectiveMaterial(def(), assignment()).ior).toBe(1.49);
  });
});

describe('renderer mappings agree', () => {
  it('carries the same shared values into three.js and Cycles', () => {
    const d = def({
      base: {
        baseColorHex: '#3366cc',
        roughness: 0.3,
        metallic: 0.2,
        ior: 1.52,
        specular: 0.6,
        clearcoat: 0.4,
        clearcoatRoughness: 0.08,
        sheen: 0.1,
        transmission: 0.25,
        thicknessMm: 2,
      },
    });
    const three = toThreeParams(d);
    const cycles = toCyclesParams(d);
    const effective = effectiveMaterial(d);

    const threeByField: Record<(typeof SHARED_MATERIAL_FIELDS)[number], number> = {
      roughness: three.roughness,
      metallic: three.metalness,
      ior: three.ior,
      specular: three.specularIntensity,
      clearcoat: three.clearcoat,
      clearcoatRoughness: three.clearcoatRoughness,
      sheen: three.sheen,
      transmission: three.transmission,
    };
    const cyclesByField: Record<(typeof SHARED_MATERIAL_FIELDS)[number], number> = {
      roughness: cycles.roughness,
      metallic: cycles.metallic,
      ior: cycles.ior,
      specular: cycles.specular_ior_level,
      clearcoat: cycles.coat_weight,
      clearcoatRoughness: cycles.coat_roughness,
      sheen: cycles.sheen_weight,
      transmission: cycles.transmission_weight,
    };

    for (const field of SHARED_MATERIAL_FIELDS) {
      expect(threeByField[field]).toBe(effective[field]);
      expect(cyclesByField[field]).toBe(effective[field]);
    }
  });

  it('describes the same colour in each renderer’s native space', () => {
    const d = def({ base: { baseColorHex: '#1b4d3e' } });
    expect(hexToLinear(toThreeParams(d).color)).toEqual(toCyclesParams(d).base_color);
  });

  it('converts millimetres to metres only for Blender', () => {
    const d = def({ base: { baseColorHex: '#ffffff', thicknessMm: 2.5 } });
    expect(toThreeParams(d).thickness).toBe(2.5);
    expect(toCyclesParams(d).thickness_m).toBeCloseTo(0.0025, 9);
  });

  it('flags transparency for three.js only when the material transmits', () => {
    expect(toThreeParams(def()).transparent).toBe(false);
    expect(toThreeParams(def({ base: { baseColorHex: '#ffffff', transmission: 0.9 } })).transparent).toBe(true);
  });
});

describe('fixture pack materials', () => {
  it.each(['cap-basic', 'box-basic'])('maps every material in %s to both renderers', (pack) => {
    const materials = packMaterials(pack);
    expect(materials.length).toBeGreaterThan(0);
    for (const m of materials) {
      const three = toThreeParams(m);
      const cycles = toCyclesParams(m);
      expect(Number.isFinite(three.roughness)).toBe(true);
      expect(cycles.base_color.every((c) => c >= 0 && c <= 1)).toBe(true);
      expect(hexToLinear(three.color)).toEqual(cycles.base_color);
    }
  });
});
