import { PackManifest } from './pack.js';
import { finishFor, finishOf } from './material.js';
import type { DecorationZoneDef } from './zone.js';
import { zoneExtentMm } from './zone.js';

/**
 * Structural checks a pack must pass before it can be published. The Zod schema proves the shape;
 * these prove the pack is usable — unique keys, materials that exist, frames that are actually
 * orthogonal, zones that fit on the thing they decorate.
 *
 * Nothing here knows what kind of product it is looking at (F-GEN-01/09).
 */

export type PackIssueSeverity = 'error' | 'warning';

export type PackIssueCode =
  | 'duplicate_key'
  | 'material_missing'
  | 'zone_target_missing'
  | 'safe_margin_too_large'
  | 'degenerate_frame'
  | 'zone_exceeds_circumference'
  | 'invalid_uv_rect'
  | 'invalid_bbox'
  | 'no_zones'
  /** A material's declared finish is not the one its own shading numbers describe (F-MAT-03). */
  | 'finish_disagrees_with_base'
  /** A slot restricts finishes, and no material it allows has one of them. */
  | 'no_material_for_finish'
  | 'no_camera_presets'
  /** Raised at import, not by the pure validator: only the importer can see the files. */
  | 'asset_missing'
  /** The document is not a manifest at all — raised where a manifest arrives from outside. */
  | 'schema_invalid'
  /** A declared asset is a file type this platform will not serve — source CAD, an archive, code. */
  | 'asset_type_refused'
  /** Raised at import: this key and version is already published with different contents. */
  | 'version_exists';

export interface PackIssue {
  severity: PackIssueSeverity;
  code: PackIssueCode;
  message: string;
  path: string;
}

const err = (code: PackIssueCode, path: string, message: string): PackIssue => ({
  severity: 'error',
  code,
  path,
  message,
});

const warn = (code: PackIssueCode, path: string, message: string): PackIssue => ({
  severity: 'warning',
  code,
  path,
  message,
});

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes];
}

const norm = (v: readonly [number, number, number]): number => Math.hypot(v[0], v[1], v[2]);

const dot3 = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function checkZone(zone: DecorationZoneDef, path: string): PackIssue[] {
  const issues: PackIssue[] = [];
  const extent = zoneExtentMm(zone);

  if (extent.safeMarginMm * 2 >= Math.min(extent.w, extent.h)) {
    issues.push(
      err(
        'safe_margin_too_large',
        path,
        `Safe margin ${extent.safeMarginMm} mm leaves no usable area in a ${extent.w} x ${extent.h} mm zone.`,
      ),
    );
  }

  if (zone.type === 'planar' || zone.type === 'conformal') {
    const { normal, tangent } = zone.frame;
    if (norm(normal) < 1e-6 || norm(tangent) < 1e-6) {
      issues.push(err('degenerate_frame', path, 'Zone frame has a zero-length axis.'));
    } else {
      const cosAngle = Math.abs(dot3(normal, tangent)) / (norm(normal) * norm(tangent));
      if (cosAngle > 0.999) {
        issues.push(err('degenerate_frame', path, 'Zone normal and tangent are parallel.'));
      } else if (cosAngle > 1e-3) {
        issues.push(
          warn(
            'degenerate_frame',
            path,
            'Zone tangent is not perpendicular to the normal; it will be orthogonalized.',
          ),
        );
      }
    }
  }

  if (zone.type === 'cylindrical') {
    const circumference = 2 * Math.PI * zone.frame.radiusMm;
    if (zone.sizeMm.arcWidthMm > circumference) {
      issues.push(
        err(
          'zone_exceeds_circumference',
          path,
          `Zone wraps ${zone.sizeMm.arcWidthMm} mm around a ${circumference.toFixed(1)} mm circumference.`,
        ),
      );
    }
  }

  const rect = 'uvRect' in zone ? zone.uvRect : undefined;
  if (rect && (rect.u1 <= rect.u0 || rect.v1 <= rect.v0)) {
    issues.push(err('invalid_uv_rect', path, 'UV rectangle is empty or inverted.'));
  }

  return issues;
}

/**
 * What a pack is allowed to ship, by extension (docs/05-security.md: no source CAD reachable from
 * any authenticated client route).
 *
 * Meshes reach the browser as glTF and textures as web image formats, and that is the whole list.
 * The point is not that a STEP file would break something — it is that source CAD is the most
 * valuable thing a customer's supplier owns, and a pack that declared one would have it served to
 * every signed-in account by a route doing exactly what it was told. An allow-list is the only
 * version of this rule that stays true when someone invents a new extension.
 */
const SERVABLE_EXTENSIONS = new Set([
  '.glb',
  '.gltf',
  '.bin',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ktx2',
  '.basis',
  '.svg',
]);

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
};

/** Every `{ path }` a manifest points at, with where it was found, so an issue can name it. */
function declaredAssetPaths(manifest: PackManifest): { path: string; at: string }[] {
  const found: { path: string; at: string }[] = [];
  const add = (ref: unknown, at: string) => {
    if (ref && typeof ref === 'object' && typeof (ref as { path?: unknown }).path === 'string') {
      found.push({ path: (ref as { path: string }).path, at });
    }
  };

  for (const product of manifest.products) {
    for (const variant of product.variants) {
      for (const [slot, ref] of Object.entries(variant.assets)) {
        add(ref, `products.${product.key}.variants.${variant.key}.assets.${slot}`);
      }
    }
  }
  for (const material of manifest.materials) {
    for (const [slot, ref] of Object.entries(material.maps)) {
      add(ref, `materials.${material.key}.maps.${slot}`);
    }
  }

  return found;
}

export function checkPackInvariants(manifest: PackManifest): PackIssue[] {
  const issues: PackIssue[] = [];
  const materialKeys = new Set(manifest.materials.map((m) => m.key));

  for (const { path, at } of declaredAssetPaths(manifest)) {
    const extension = extensionOf(path);
    if (!SERVABLE_EXTENSIONS.has(extension)) {
      issues.push(
        err(
          'asset_type_refused',
          at,
          `"${path}" is not a file this platform serves. Packs ship meshes as glTF and textures as ` +
            `web images; source CAD and anything else stays out of the archive.`,
        ),
      );
    }
  }

  for (const material of manifest.materials) {
    if (!material.finish) continue;
    const implied = finishFor(material.base);
    if (material.finish !== implied) {
      // A warning rather than an error, because an author may know something the thresholds do not
      // — but it is worth saying, because a material labelled gloss and shaded matte misleads
      // exactly the person the label exists for.
      issues.push(
        warn(
          'finish_disagrees_with_base',
          `materials.${material.key}`,
          `"${material.key}" is labelled ${material.finish}, but its shading reads as ${implied} ` +
            `(roughness ${material.base.roughness}, metallic ${material.base.metallic}, ` +
            `clearcoat ${material.base.clearcoat}, sheen ${material.base.sheen}).`,
        ),
      );
    }
  }

  for (const dupe of duplicates(manifest.products.map((p) => p.key))) {
    issues.push(err('duplicate_key', `products`, `Duplicate product key "${dupe}".`));
  }

  for (const product of manifest.products) {
    const productPath = `products.${product.key}`;
    for (const dupe of duplicates(product.variants.map((v) => v.key))) {
      issues.push(err('duplicate_key', productPath, `Duplicate variant key "${dupe}".`));
    }

    for (const variant of product.variants) {
      const path = `${productPath}.${variant.key}`;

      for (const dupe of duplicates(variant.materialSlots.map((s) => s.key))) {
        issues.push(err('duplicate_key', path, `Duplicate material slot "${dupe}".`));
      }
      for (const dupe of duplicates(variant.zones.map((z) => z.key))) {
        issues.push(err('duplicate_key', path, `Duplicate zone key "${dupe}".`));
      }
      for (const dupe of duplicates(variant.cameraPresets.map((c) => c.key))) {
        issues.push(err('duplicate_key', path, `Duplicate camera preset "${dupe}".`));
      }

      for (const slot of variant.materialSlots) {
        if (slot.allowedFinishes.length > 0) {
          const offered = manifest.materials.filter(
            (material) =>
              (slot.allowedFamilies.length === 0 ||
                slot.allowedFamilies.includes(material.family)) &&
              slot.allowedFinishes.includes(finishOf(material)),
          );
          if (offered.length === 0) {
            // A slot that restricts to a finish nothing in the pack has is a dropdown with nothing
            // in it — which the editor renders as an empty select rather than as an error.
            issues.push(
              warn(
                'no_material_for_finish',
                `${path}.${slot.key}`,
                `Slot allows only ${slot.allowedFinishes.join(', ')}, and no material in this pack ` +
                  'has one of those finishes.',
              ),
            );
          }
        }

        if (!materialKeys.has(slot.defaultMaterialKey)) {
          // Not fatal: the deployment's shared library may provide it. Import verifies for real.
          issues.push(
            warn(
              'material_missing',
              `${path}.${slot.key}`,
              `Default material "${slot.defaultMaterialKey}" is not embedded in this pack.`,
            ),
          );
        }
      }

      const [min, max] = variant.dimensionsMm.bbox;
      if (max[0] <= min[0] || max[1] <= min[1] || max[2] <= min[2]) {
        issues.push(err('invalid_bbox', path, 'Bounding box is empty or inverted.'));
      }

      if (variant.zones.length === 0) {
        issues.push(
          warn(
            'no_zones',
            path,
            'Variant has no decoration zones; artwork cannot be placed on it.',
          ),
        );
      }
      if (variant.cameraPresets.length === 0) {
        issues.push(
          warn(
            'no_camera_presets',
            path,
            'Variant has no camera presets; framing falls back to defaults.',
          ),
        );
      }

      for (const zone of variant.zones) {
        issues.push(...checkZone(zone, `${path}.${zone.key}`));
        if (
          zone.materialSlotKey &&
          !variant.materialSlots.some((slot) => slot.key === zone.materialSlotKey)
        ) {
          issues.push(
            err(
              'zone_target_missing',
              `${path}.${zone.key}.materialSlotKey`,
              'Artwork target must name a material slot in this variant.',
            ),
          );
        }
      }
    }
  }

  return issues;
}

export interface PackValidationResult {
  manifest: PackManifest;
  issues: PackIssue[];
  errors: PackIssue[];
  publishable: boolean;
}

/** Parses and checks a manifest. Throws only when the document is not a manifest at all. */
export function validatePack(raw: unknown): PackValidationResult {
  const manifest = PackManifest.parse(raw);
  const issues = checkPackInvariants(manifest);
  const errors = issues.filter((i) => i.severity === 'error');
  return { manifest, issues, errors, publishable: errors.length === 0 };
}
