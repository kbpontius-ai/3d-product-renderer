import { describe, expect, it } from 'vitest';
import { FINISH_FAMILIES, MaterialDefinition, finishFor, finishOf } from './material.js';
import { checkPackInvariants } from './pack-validate.js';
import { PackManifest } from './pack.js';

/**
 * Finish families (F-MAT-03).
 *
 * The axis a customer actually shops on — they ask for a soft-touch closure, not for sheen 0.4.
 * What these check is that it stays a *label* rather than becoming a second set of shading numbers:
 * `base` is authoritative for both renderers, and a finish that could contradict it would give the
 * preview and the render two different opinions about the same material.
 */

const base = (over: Partial<Record<string, number>> = {}) => ({
  baseColorHex: '#1b4d3e',
  roughness: 0.5,
  metallic: 0,
  ior: 1.5,
  specular: 0.5,
  clearcoat: 0,
  clearcoatRoughness: 0.05,
  sheen: 0,
  transmission: 0,
  thicknessMm: 0,
  emissiveStrength: 0,
  ...over,
});

describe('finishFor', () => {
  it('reads the six families off the shading numbers', () => {
    expect(finishFor(base({ roughness: 0.08 }))).toBe('gloss');
    expect(finishFor(base({ roughness: 0.34 }))).toBe('satin');
    expect(finishFor(base({ roughness: 0.72 }))).toBe('matte');
    expect(finishFor(base({ metallic: 1, roughness: 0.18 }))).toBe('metallic');
    expect(finishFor(base({ roughness: 0.78, sheen: 0.45 }))).toBe('soft-touch');
    expect(finishFor(base({ roughness: 0.28, clearcoat: 0.55, sheen: 0.35 }))).toBe('pearlescent');
  });

  it('lets metal win over how smooth it is', () => {
    // A polished aluminium closure is metallic before it is gloss: the thing a customer is choosing
    // is the metal, and roughness is how polished that metal happens to be.
    expect(finishFor(base({ metallic: 1, roughness: 0.05 }))).toBe('metallic');
    expect(finishFor(base({ metallic: 1, roughness: 0.9 }))).toBe('metallic');
  });

  it('tells soft-touch from matte by the sheen, not the roughness', () => {
    // Both are rough. The sheen lobe is the velvety part your fingers expect from soft-touch
    // lacquer, and it is the only thing in the numbers that distinguishes them.
    expect(finishFor(base({ roughness: 0.78, sheen: 0 }))).toBe('matte');
    expect(finishFor(base({ roughness: 0.78, sheen: 0.45 }))).toBe('soft-touch');
  });

  it('covers the whole roughness range with no gaps', () => {
    // Every plain dielectric has to land somewhere, or a material would have no finish at all.
    for (let roughness = 0; roughness <= 1.0001; roughness += 0.05) {
      expect(FINISH_FAMILIES).toContain(finishFor(base({ roughness: Number(roughness.toFixed(2)) })));
    }
  });
});

describe('finishOf', () => {
  it('prefers what the material declared', () => {
    const material = MaterialDefinition.parse({
      key: 'odd', name: 'Odd', family: 'plastic', finish: 'soft-touch', base: base({ roughness: 0.1 }),
    });
    expect(finishOf(material)).toBe('soft-touch');
  });

  it('falls back to the numbers for a pack written before finishes existed', () => {
    // The reason `finish` is optional: every pack already published keeps working, and gets the
    // finish it was always describing.
    const material = MaterialDefinition.parse({
      key: 'legacy', name: 'Legacy', family: 'plastic', base: base({ roughness: 0.1 }),
    });
    expect(material.finish).toBeUndefined();
    expect(finishOf(material)).toBe('gloss');
  });
});

describe('a pack whose label and shading disagree', () => {
  const pack = (materials: unknown[], allowedFinishes: string[] = []) =>
    PackManifest.parse({
      manifestVersion: 1,
      key: 'test', version: '1.0.0', name: 'Test',
      materials,
      products: [{
        key: 'p', name: 'P', category: 'c',
        variants: [{
          key: 'v', name: 'V',
          dimensionsMm: { bbox: [[-1, 0, -1], [1, 2, 1]] },
          assets: { lod0: { path: 'a.glb' }, renderMesh: { path: 'b.glb' } },
          materialSlots: [{ key: 'body', label: 'Body', defaultMaterialKey: 'm', allowedFinishes }],
        }],
      }],
    });

  it('is warned about, because the label misleads the person it is for', () => {
    const manifest = pack([
      { key: 'm', name: 'Liar', family: 'plastic', finish: 'gloss', base: base({ roughness: 0.9 }) },
    ]);
    const issue = checkPackInvariants(manifest).find((i) => i.code === 'finish_disagrees_with_base');

    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('labelled gloss');
    expect(issue?.message).toContain('reads as matte');
  });

  // Advisory rather than blocking: an author may know something the thresholds do not, and refusing
  // to publish over a taste judgement is not this checker's job.
  it('is still publishable', () => {
    const manifest = pack([
      { key: 'm', name: 'Liar', family: 'plastic', finish: 'gloss', base: base({ roughness: 0.9 }) },
    ]);
    expect(checkPackInvariants(manifest).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('says nothing when the two agree', () => {
    const manifest = pack([
      { key: 'm', name: 'Honest', family: 'plastic', finish: 'matte', base: base({ roughness: 0.9 }) },
    ]);
    expect(checkPackInvariants(manifest).some((i) => i.code === 'finish_disagrees_with_base')).toBe(false);
  });
});

describe('a slot that restricts finishes', () => {
  it('is warned about when the pack has nothing to offer it', () => {
    // Otherwise the editor renders an empty dropdown, which looks like a bug in the editor rather
    // than a mistake in the pack.
    const manifest = PackManifest.parse({
      manifestVersion: 1,
      key: 'test', version: '1.0.0', name: 'Test',
      materials: [{ key: 'm', name: 'M', family: 'plastic', finish: 'matte', base: base({ roughness: 0.9 }) }],
      products: [{
        key: 'p', name: 'P', category: 'c',
        variants: [{
          key: 'v', name: 'V',
          dimensionsMm: { bbox: [[-1, 0, -1], [1, 2, 1]] },
          assets: { lod0: { path: 'a.glb' }, renderMesh: { path: 'b.glb' } },
          materialSlots: [
            { key: 'body', label: 'Body', defaultMaterialKey: 'm', allowedFinishes: ['pearlescent'] },
          ],
        }],
      }],
    });

    const issue = checkPackInvariants(manifest).find((i) => i.code === 'no_material_for_finish');
    expect(issue?.message).toContain('pearlescent');
  });
});
