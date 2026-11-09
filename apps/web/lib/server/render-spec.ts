import 'server-only';
import { createHash } from 'node:crypto';
import { loadArtworkVersion } from '@pr/artworks';
import {
  getDesignProduct,
  listMaterials,
  type CatalogProduct,
  type CatalogVariant,
} from '@pr/catalog';
import type { TenantContext } from '@pr/db';
import type { Camera, DesignDocument, RenderSpec, RenderLighting } from '@pr/design-schema';
import { boundingSphere, framePreset, effectiveOrientation } from '@pr/scene';
import { buildRenderSpec, type OutputRequest } from '@pr/render-spec';
import { getSql } from './db.js';
import { HttpError } from './http.js';

/**
 * Turning a saved design into a render job's input (build order H1).
 *
 * Everything the worker will ever read is resolved here: mesh, zones, materials, artwork assets and
 * an explicit camera. The worker looks nothing up for itself, which is what makes a job reproducible
 * — re-running one a month later renders what was submitted, not what the catalog says today.
 */

/** 1K / 2K / 4K presets; a custom size is allowed up to the organisation's quota (F-REND-06). */
export const RENDER_SIZES = {
  '1k': { widthPx: 1024, heightPx: 1024, label: '1K (1024 px)' },
  '2k': { widthPx: 2048, heightPx: 2048, label: '2K (2048 px)' },
  '4k': { widthPx: 4096, heightPx: 4096, label: '4K (4096 px)' },
} as const;

export type RenderSizeKey = keyof typeof RENDER_SIZES;
export type RenderPreset = 'draft' | 'standard' | 'final';

/**
 * What the file will be.
 *
 * PNG-16 is the default because a render is usually an intermediate — someone composites it, and
 * eight bits of gradient in a soft studio backdrop bands visibly. JPEG cannot carry alpha at all,
 * which is why a transparent background silently means PNG or WebP.
 */
export const RENDER_FORMATS = {
  png16: { label: 'PNG · 16-bit', alpha: true },
  png8: { label: 'PNG · 8-bit', alpha: true },
  webp: { label: 'WebP', alpha: true },
  jpeg: { label: 'JPEG', alpha: false },
} as const;

export type RenderFormatKey = keyof typeof RENDER_FORMATS;

export interface BuildSpecInput {
  document: DesignDocument;
  designVersionId: string;
  preset: RenderPreset;
  /** A named size, or an exact one the organisation's quota allows. */
  size: RenderSizeKey | { widthPx: number; heightPx: number };
  format?: RenderFormatKey;
  rendererVersion: string;
  lighting?: RenderLighting;
}

export async function buildSpecForDesign(
  ctx: TenantContext,
  input: BuildSpecInput,
): Promise<RenderSpec> {
  const sql = getSql();
  const { variant } = await findVariant(ctx, input.document);

  const meshKey = variant.assets.render_mesh ?? variant.assets.lod0;
  if (!meshKey) throw new HttpError(422, 'product_not_renderable', 'this product ships no mesh');

  const materials = await listMaterials(sql, ctx);
  // Slot assignments, and the ink a placement names. The ink was missing until the artwork's mark
  // started shading from its own material: the worker resolves `inkMaterialKey` against this list,
  // and a key whose definition never travelled would have silently fallen back to the old
  // constants — the mark rendering matte black while the editor showed it gold.
  const used = new Set(Object.values(input.document.materials).map((m) => m.materialKey));
  for (const placement of input.document.placements) {
    if (placement.finish.inkMaterialKey) used.add(placement.finish.inkMaterialKey);
  }

  const artwork: RenderSpec['resolved']['artwork'] = [];
  for (const placement of input.document.placements) {
    const record = await loadArtworkVersion(sql, ctx, placement.artwork.versionId);
    artwork.push({
      versionId: record.versionId,
      maskKey: record.maskKey,
      sdfKey: record.sdfKey,
      sdfRangeMm: record.sdfRangeMm,
      mmPerPx: record.mmPerPx,
      // Assets are immutable under their key, so their identity is the key. A digest is recorded
      // when the pipeline starts storing one; until then the worker has nothing to check against.
      digest: '0'.repeat(64),
    });
  }

  const size = typeof input.size === 'string' ? RENDER_SIZES[input.size] : input.size;
  const format = input.format ?? 'png16';
  // Alpha is not a separate choice: it is what "no background" means, and only where the format
  // can carry it. Offering both would let someone ask for a transparent JPEG.
  const alpha =
    input.document.scene.background.kind === 'transparent' && RENDER_FORMATS[format].alpha;

  const output: OutputRequest = {
    kind: 'image',
    widthPx: size.widthPx,
    heightPx: size.heightPx,
    format,
    alpha,
    camera: resolveCamera(input.document, variant),
  };

  return buildRenderSpec({
    document: input.document,
    resolved: {
      presentationOrientation: effectiveOrientation(
        variant.presentationOrientation,
        input.document.scene.presentationOrientationOverride,
      ),
      meshKey,
      meshDigest: '0'.repeat(64),
      bboxMm: variant.bboxMm,
      zones: variant.zones,
      artwork,
      materials: materials
        .filter((m) => used.has(m.key))
        .map((m) => ({ key: m.key, version: m.definition.version, definition: m.definition })),
      environment: {
        key: input.lighting?.environmentKey ?? input.document.scene.environmentKey,
        // The built-in studio, rather than an HDRI file: lifestyle environments are a v3 feature,
        // and a rig sized to the product is what v1 promises.
        hdriKey: `builtin:${input.lighting?.environmentKey ?? input.document.scene.environmentKey}`,
        rotationDeg: input.lighting?.rotationDeg ?? input.document.scene.environmentRotationDeg,
        exposureEv: input.document.scene.exposureEv,
        ...(input.lighting?.orientation ? { orientation: input.lighting.orientation } : {}),
      },
    },
    outputs: [output],
    preset: input.preset,
    renderer: { id: 'cycles', version: input.rendererVersion },
    // Fixed per design version, so re-rendering reproduces the same noise and not just the same
    // look — which is what makes two renders comparable.
    seed: seedFor(input.designVersionId),
  });
}

/**
 * The camera, resolved to explicit numbers by the same function the preview frames with.
 *
 * A preset name would leave the worker to re-derive framing, and any difference between the two
 * derivations is a render that does not match what the user approved.
 */
function resolveCamera(document: DesignDocument, variant: CatalogVariant): Camera {
  if (document.scene.camera.kind === 'custom') return document.scene.camera;

  const wanted = document.scene.camera.presetKey;
  const preset = variant.cameraPresets.find((p) => p.key === wanted) ?? variant.cameraPresets[0];
  if (!preset) throw new HttpError(422, 'product_not_renderable', 'this product has no camera');

  const resolved = framePreset(
    preset,
    boundingSphere(variant.bboxMm),
    undefined,
    effectiveOrientation(
      variant.presentationOrientation,
      document.scene.presentationOrientationOverride,
    ),
  );
  return {
    kind: 'custom',
    positionMm: resolved.positionMm,
    targetMm: resolved.targetMm,
    upMm: resolved.upMm,
    focalMm: resolved.focalMm,
    sensorMm: resolved.sensorMm,
  };
}

async function findVariant(
  ctx: TenantContext,
  document: DesignDocument,
): Promise<{ product: CatalogProduct; variant: CatalogVariant }> {
  // The version the design was made on, even if a newer one has since replaced it.
  const product = await getDesignProduct(getSql(), ctx, document.product);
  const variant = product?.variants.find((v) => v.key === document.product.variantKey);

  if (!product || !variant) {
    throw new HttpError(422, 'product_unavailable', 'this design’s product is no longer available');
  }
  return { product, variant };
}

/** A stable 31-bit seed from the version id, so the same design always traces the same noise. */
const seedFor = (designVersionId: string): number =>
  createHash('sha256').update(designVersionId).digest().readUInt32BE(0) & 0x7fffffff;
