import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPackInvariants, validatePack } from './pack-validate.js';
import type { PackManifest } from './pack.js';

const FIXTURE_PACKS = ['cap-basic', 'box-basic'] as const;

function loadFixturePack(key: (typeof FIXTURE_PACKS)[number]): unknown {
  const path = fileURLToPath(
    new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The genericity gate (F-GEN-09) in miniature: both fixture packs — a small curved closure and a
 * large flat carton — go through exactly the same validation with the same expectations.
 */
describe.each(FIXTURE_PACKS)('fixture pack %s', (key) => {
  const raw = loadFixturePack(key);

  it('parses against the manifest schema', () => {
    expect(() => validatePack(raw)).not.toThrow();
  });

  it('is publishable', () => {
    const result = validatePack(raw);
    expect(result.errors).toEqual([]);
    expect(result.publishable).toBe(true);
  });

  it('embeds the materials its slots default to', () => {
    const result = validatePack(raw);
    expect(result.issues.filter((i) => i.code === 'material_missing')).toEqual([]);
  });

  it('declares at least one variant with zones and camera presets', () => {
    const { manifest } = validatePack(raw);
    for (const product of manifest.products) {
      for (const variant of product.variants) {
        expect(variant.zones.length).toBeGreaterThan(0);
        expect(variant.cameraPresets.length).toBeGreaterThan(0);
        expect(variant.materialSlots.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every zone usable after its safe margin', () => {
    const { manifest } = validatePack(raw);
    for (const product of manifest.products) {
      for (const variant of product.variants) {
        for (const zone of variant.zones) {
          const size = zone.type === 'cylindrical' ? zone.sizeMm.arcWidthMm : zone.sizeMm.width;
          expect(size - 2 * zone.sizeMm.safeMarginMm).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('the two fixture packs are genuinely dissimilar', () => {
  it('use different zone types with the approved shared material palette', () => {
    const cap = validatePack(loadFixturePack('cap-basic')).manifest;
    const box = validatePack(loadFixturePack('box-basic')).manifest;

    const zoneTypes = (m: PackManifest) =>
      new Set(m.products.flatMap((p) => p.variants.flatMap((v) => v.zones.map((z) => z.type))));

    expect([...zoneTypes(cap)].sort()).toEqual(['cylindrical', 'planar']);
    expect([...zoneTypes(box)]).toEqual(['flat_panel']);
    for (const manifest of [cap, box]) {
      expect(manifest.materials.map((material) => material.key).sort()).toEqual([
        'pp-gloss',
        'pp-matte',
      ]);
      expect([...new Set(manifest.materials.map((material) => material.family))]).toEqual([
        'plastic',
      ]);
    }
  });
});

describe('checkPackInvariants', () => {
  const base = () => validatePack(loadFixturePack('cap-basic')).manifest;

  it('preserves an explicit decoration target and rejects undeclared parts', () => {
    const manifest = base();
    const variant = manifest.products[0]!.variants[0]!;
    variant.zones[0]!.materialSlotKey = variant.materialSlots[0]!.key;
    expect(
      validatePack(manifest).manifest.products[0]!.variants[0]!.zones[0]!.materialSlotKey,
    ).toBe(variant.materialSlots[0]!.key);
    variant.zones[0]!.materialSlotKey = 'missing-part';
    expect(checkPackInvariants(manifest).map((issue) => issue.code)).toContain(
      'zone_target_missing',
    );
  });

  it('flags duplicate zone keys', () => {
    const m = base();
    const variant = m.products[0]!.variants[0]!;
    variant.zones.push({ ...variant.zones[0]! });
    expect(checkPackInvariants(m).map((i) => i.code)).toContain('duplicate_key');
  });

  it('flags a safe margin that eats the whole zone', () => {
    const m = base();
    const zone = m.products[0]!.variants[0]!.zones[0]!;
    zone.sizeMm.safeMarginMm = 20;
    const issues = checkPackInvariants(m);
    expect(issues.map((i) => i.code)).toContain('safe_margin_too_large');
  });

  it('flags a zone that wraps further than the product’s circumference', () => {
    const m = base();
    const zone = m.products[0]!.variants[0]!.zones.find((z) => z.type === 'cylindrical')!;
    if (zone.type === 'cylindrical') zone.sizeMm.arcWidthMm = 1000;
    expect(checkPackInvariants(m).map((i) => i.code)).toContain('zone_exceeds_circumference');
  });

  it('flags a degenerate zone frame', () => {
    const m = base();
    const zone = m.products[0]!.variants[0]!.zones.find((z) => z.type === 'planar')!;
    if (zone.type === 'planar') zone.frame.tangent = [0, 1, 0]; // parallel to the normal
    const issues = checkPackInvariants(m);
    expect(issues.some((i) => i.code === 'degenerate_frame' && i.severity === 'error')).toBe(true);
  });

  it('flags a missing default material as a warning, not a blocker', () => {
    const m = base();
    m.products[0]!.variants[0]!.materialSlots[0]!.defaultMaterialKey = 'not-in-this-pack';
    const issues = checkPackInvariants(m);
    const issue = issues.find((i) => i.code === 'material_missing');
    expect(issue?.severity).toBe('warning');
  });

  it('flags an inverted bounding box', () => {
    const m = base();
    m.products[0]!.variants[0]!.dimensionsMm.bbox = [
      [1, 1, 1],
      [0, 0, 0],
    ];
    expect(checkPackInvariants(m).map((i) => i.code)).toContain('invalid_bbox');
  });
});

describe('what a pack may ship (docs/05-security.md: no source CAD reachable)', () => {
  const base = () => validatePack(loadFixturePack('cap-basic')).manifest;

  const withMeshPath = (path: string) => {
    const manifest = base();
    manifest.products[0]!.variants[0]!.assets.lod0 = { path };
    return manifest;
  };

  it('refuses source CAD, whatever the flavour', () => {
    // The thing actually being protected: a supplier's CAD is the most valuable file in the
    // pipeline, and a pack that declared one would have it served to every signed-in account.
    for (const path of [
      'meshes/cap.step',
      'meshes/cap.stp',
      'meshes/cap.iges',
      'meshes/cap.igs',
      'meshes/cap.sldprt',
      'meshes/cap.f3d',
      'meshes/cap.x_t',
      'meshes/cap.3dm',
    ]) {
      const issues = checkPackInvariants(withMeshPath(path));
      expect(
        issues.some((i) => i.code === 'asset_type_refused' && i.severity === 'error'),
        `${path} was accepted`,
      ).toBe(true);
    }
  });

  it('refuses archives and code, which are how a CAD file arrives in disguise', () => {
    for (const path of [
      'meshes/cap.zip',
      'meshes/cap.tar.gz',
      'meshes/cap.js',
      'meshes/cap.html',
    ]) {
      const issues = checkPackInvariants(withMeshPath(path));
      expect(
        issues.some((i) => i.code === 'asset_type_refused'),
        `${path} was accepted`,
      ).toBe(true);
    }
  });

  it('is not fooled by case or by a CAD extension buried mid-path', () => {
    expect(
      checkPackInvariants(withMeshPath('meshes/cap.STEP')).some(
        (i) => i.code === 'asset_type_refused',
      ),
    ).toBe(true);
    // The extension is the last one, not any that appears: `cap.step.glb` is a glTF file.
    expect(
      checkPackInvariants(withMeshPath('meshes/cap.step.glb')).some(
        (i) => i.code === 'asset_type_refused',
      ),
    ).toBe(false);
  });

  it('accepts the formats the browser and the renderer actually consume', () => {
    for (const path of [
      'meshes/cap.glb',
      'meshes/cap.gltf',
      'textures/base.png',
      'textures/base.webp',
    ]) {
      expect(
        checkPackInvariants(withMeshPath(path)).some((i) => i.code === 'asset_type_refused'),
        `${path} was refused`,
      ).toBe(false);
    }
  });

  it('checks texture maps as well as meshes', () => {
    const manifest = base();
    manifest.materials[0]!.maps = { baseColor: { path: 'textures/leak.step' } } as never;
    expect(checkPackInvariants(manifest).some((i) => i.code === 'asset_type_refused')).toBe(true);
  });
});
