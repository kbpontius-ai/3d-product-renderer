import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePack, type MaterialDefinition, type PackManifest } from '@pr/design-schema';
import type { EditorArtwork, EditorZone } from './editor-data.js';

export type { EditorArtwork, EditorZone, StoredArtwork } from './editor-data.js';

/**
 * Server-side fixture loading.
 *
 * Stands in for the catalog API and object storage until those exist: packs are read from
 * `fixtures/packs`, artwork from `fixtures/artwork`. The shapes handed to the client are the same
 * ones the real endpoints will return (docs/13-api.md), so the editor never learns it is on
 * fixtures.
 */

const REPO_ROOT = join(process.cwd(), '..', '..');

export const FIXTURE_PACK_KEYS = ['cap-basic', 'bottle-oval', 'box-basic'] as const;
export type FixturePackKey = (typeof FIXTURE_PACK_KEYS)[number];

export function loadPack(key: FixturePackKey): PackManifest {
  const path = join(REPO_ROOT, 'fixtures', 'packs', key, 'manifest.json');
  return validatePack(JSON.parse(readFileSync(path, 'utf8'))).manifest;
}

/** The bundled sample mark. It has no `ref`: it is not in anyone's library, so it is never placed. */
export function loadArtwork(key: string): EditorArtwork {
  const path = join(REPO_ROOT, 'fixtures', 'artwork', key, 'meta.json');
  const meta = JSON.parse(readFileSync(path, 'utf8')) as Omit<EditorArtwork, 'maskUrl'>;
  return { ...meta, maskUrl: `/api/fixtures/artwork/${key}/mask.png` };
}

/** Path traversal guard: plain segments only, resolved inside the fixtures directory. */
function safeFixturePath(kind: 'artwork' | 'packs', segments: string[]): string {
  if (
    segments.length === 0 ||
    segments.some((s) => s.includes('..') || s.includes('/') || s.includes('\\'))
  ) {
    throw new Error('invalid fixture path');
  }
  return join(REPO_ROOT, 'fixtures', kind, ...segments);
}

export function readFixtureArtworkFile(segments: string[]): Buffer {
  return readFileSync(safeFixturePath('artwork', segments));
}

export function readFixturePackFile(segments: string[]): Buffer {
  return readFileSync(safeFixturePath('packs', segments));
}

export interface EditorData {
  zones: EditorZone[];
  materials: Record<string, MaterialDefinition>;
}

/** Flattens the packs into the zone list the editor's face rail shows. */
export function loadEditorData(packKeys: readonly FixturePackKey[]): EditorData {
  const zones: EditorZone[] = [];
  const materials: Record<string, MaterialDefinition> = {};

  for (const packKey of packKeys) {
    const manifest = loadPack(packKey);
    for (const material of manifest.materials) materials[material.key] = material;

    for (const product of manifest.products) {
      for (const variant of product.variants) {
        const meshPath = variant.assets.lod0.path;
        for (const zone of variant.zones) {
          zones.push({
            key: `${packKey}/${product.key}/${variant.key}/${zone.key}`,
            name: `${variant.name} — ${zone.name}`,
            type: zone.type,
            widthMm: zone.type === 'cylindrical' ? zone.sizeMm.arcWidthMm : zone.sizeMm.width,
            heightMm: zone.sizeMm.height,
            safeMarginMm: zone.sizeMm.safeMarginMm,
            definition: zone,
            packKey,
            productKey: product.key,
            variantKey: variant.key,
            meshUrl: `/api/fixtures/packs/${packKey}/meshes/${meshPath.replace(/^meshes\//, '')}`,
            bboxMm: variant.dimensionsMm.bbox,
            cameraPresets: variant.cameraPresets,
            presentationOrientation: variant.presentationOrientation,
            defaultMaterialKey: variant.materialSlots[0]!.defaultMaterialKey,
            materialSlots: variant.materialSlots.map((slot) => ({
              key: slot.key,
              label: slot.label,
              defaultMaterialKey: slot.defaultMaterialKey,
              allowedFamilies: slot.allowedFamilies,
              allowedFinishes: slot.allowedFinishes,
              colorizable: slot.colorizable,
            })),
          });
        }
      }
    }
  }

  return { zones, materials };
}
