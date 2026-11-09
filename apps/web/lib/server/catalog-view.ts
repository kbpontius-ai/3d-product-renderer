import 'server-only';
import { zoneExtentMm, type FinishFamily, type MaterialDefinition } from '@pr/design-schema';
import type { CatalogMaterial, CatalogProduct, CatalogVariant } from '@pr/catalog';
import type { EditorZone } from '../editor-data.js';
import { sharedAssetUrl } from './storage.js';

/**
 * Catalog rows → what the editor draws.
 *
 * The same shape `loadEditorData` builds from fixtures, so the editor takes a design from the
 * database and one from a pack on disk without knowing which it has.
 */

export function editorZones(product: CatalogProduct, variant: CatalogVariant): EditorZone[] {
  const meshKey = variant.assets.lod0;

  return variant.zones.map((zone) => {
    const extent = zoneExtentMm(zone);
    return {
      // One variant per design, so the pack's own zone key is already unique in this list.
      key: zone.key,
      name: zone.name,
      type: zone.type,
      widthMm: extent.w,
      heightMm: extent.h,
      safeMarginMm: extent.safeMarginMm,
      definition: zone,
      packKey: product.packKey,
      productKey: product.productKey,
      variantKey: variant.key,
      meshUrl: meshKey ? sharedAssetUrl(meshKey) : '',
      bboxMm: variant.bboxMm,
      cameraPresets: variant.cameraPresets,
      presentationOrientation: variant.presentationOrientation,
      defaultMaterialKey: variant.materialSlots[0]!.defaultMaterialKey,
      materialSlots: variant.materialSlots.map((slot) => ({
        key: slot.key,
        label: slot.label,
        defaultMaterialKey: slot.defaultMaterialKey,
        allowedFamilies: (slot as { allowedFamilies?: string[] }).allowedFamilies ?? [],
        // Packs imported before finishes existed have no such field, and unrestricted is the right
        // reading of a pack that never said.
        allowedFinishes: (slot as { allowedFinishes?: FinishFamily[] }).allowedFinishes ?? [],
        colorizable: slot.colorizable,
      })),
    };
  });
}

export const materialsByKey = (materials: CatalogMaterial[]): Record<string, MaterialDefinition> =>
  Object.fromEntries(materials.map((m) => [m.key, m.definition]));
