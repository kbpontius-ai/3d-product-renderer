import {
  archivedArtworkReferences,
  assertActiveArtworkReferences,
  assertDesignArtworkActive,
  lockArtworkUsage,
  type ArchivedArtwork,
} from '@pr/artworks';
import { uuidv7, withTenant, type Sql, type TenantContext, type Tx } from '@pr/db';
import {
  CURRENT_SCHEMA_VERSION,
  zoneExtentMm,
  DesignDocument,
  migrateDesign,
  type DecorationZoneDef,
  type MaterialDefinition,
} from '@pr/design-schema';
import { getDesignProduct, listProducts, type CatalogVariant } from '@pr/catalog';
import { validateDesign, type ValidationResult } from '@pr/placement';

/**
 * Design persistence (W-03, F-PROJ-01, F-EDIT-06).
 *
 * Documents are stored whole and versioned: every save appends a version rather than overwriting
 * one, so a render's inputs stay exactly as they were when it was submitted, and "restore the
 * version we approved" is a read rather than an archaeology project.
 */

export interface DesignSummary {
  archivedArtworks?: ArchivedArtwork[];
  id: string;
  name: string;
  version: number;
  productName: string;
  variantName: string;
  updatedAt: string;
  thumbnailKey: string | null;
}

export interface LoadedDesign {
  archivedArtworks?: ArchivedArtwork[];
  id: string;
  name: string;
  version: number;
  document: DesignDocument;
  updatedAt: string;
}

export class DesignError extends Error {
  constructor(
    readonly code: 'not_found' | 'version_conflict' | 'invalid_document' | 'unknown_variant',
    message?: string,
    readonly detail?: unknown,
  ) {
    super(message ?? code);
    this.name = 'DesignError';
  }
}

export async function listDesigns(
  sql: Sql,
  ctx: TenantContext,
  limit = 50,
): Promise<DesignSummary[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select d.id, d.name, d.updated_at, d.thumbnail_key,
             dv.version, dv.document, p.name as product_name, v.name as variant_name
      from designs d
      join design_versions dv on dv.id = d.current_version_id
      join product_variants v on v.id = d.product_variant_id
      join products p on p.id = v.product_id
      where d.deleted_at is null
      order by d.updated_at desc
      limit ${limit}`;

    return Promise.all(
      rows.map(async (row) => ({
        archivedArtworks: await archivedArtworkReferences(tx, row['document'] as DesignDocument),
        id: row['id'] as string,
        name: row['name'] as string,
        version: row['version'] as number,
        productName: row['product_name'] as string,
        variantName: row['variant_name'] as string,
        updatedAt: (row['updated_at'] as Date).toISOString(),
        thumbnailKey: (row['thumbnail_key'] as string | null) ?? null,
      })),
    );
  });
}

export async function createDesign(
  sql: Sql,
  ctx: TenantContext,
  input: {
    variantId: string;
    name?: string;
    /**
     * Placements the design starts with, checked before anything is written.
     *
     * So a design and its first placement land together or not at all: the test-pattern check used
     * to create a design and then save the pattern into it, and a refused save left an empty design
     * behind in somebody's list.
     */
    placements?: DesignDocument['placements'];
  },
): Promise<LoadedDesign> {
  const variant = await findVariant(sql, ctx, input.variantId);
  if (!variant) throw new DesignError('unknown_variant', 'that product is not available');

  const document = {
    ...defaultDocument(variant.variant, variant.packKey, variant.packVersion, variant.productKey),
    ...(input.placements ? { placements: input.placements } : {}),
  };
  if (input.placements?.length) {
    const validation = await validateAgainstCatalog(sql, ctx, document);
    if (validation.errors.length > 0) {
      throw new DesignError('invalid_document', 'design has blocking problems', validation.errors);
    }
  }
  // Two designs started on the same product on the same day need to be tellable apart in the list,
  // so the default name carries the minute. UTC keeps it deterministic; the list localises the
  // "edited" time separately.
  const name =
    input.name ??
    `${variant.productName} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

  return withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    await assertActiveArtworkReferences(tx, document);
    const designId = uuidv7();
    const versionId = uuidv7();

    await tx`
      insert into designs (id, org_id, name, product_variant_id, created_by)
      values (${designId}, ${ctx.orgId}, ${name}, ${input.variantId}, ${ctx.userId})`;
    await tx`
      insert into design_versions (id, design_id, org_id, version, schema_version, document, created_by)
      values (${versionId}, ${designId}, ${ctx.orgId}, 1, ${CURRENT_SCHEMA_VERSION},
              ${sql.json(document as never)}, ${ctx.userId})`;
    await tx`update designs set current_version_id = ${versionId} where id = ${designId}`;

    return { id: designId, name, version: 1, document, updatedAt: new Date().toISOString() };
  });
}

export async function loadDesign(
  sql: Sql,
  ctx: TenantContext,
  designId: string,
): Promise<LoadedDesign> {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await tx`
      select d.id, d.name, d.updated_at, dv.version, dv.document
      from designs d
      join design_versions dv on dv.id = d.current_version_id
      where d.id = ${designId} and d.deleted_at is null`;
    if (!row) throw new DesignError('not_found');

    return {
      id: row['id'] as string,
      name: row['name'] as string,
      version: row['version'] as number,
      archivedArtworks: await archivedArtworkReferences(tx, row['document'] as DesignDocument),
      // Migrated on read: stored documents are never rewritten in place (docs/12-schemas.md).
      document: migrateDesign(row['document']),
      updatedAt: (row['updated_at'] as Date).toISOString(),
    };
  });
}

export interface SaveResult {
  version: number;
  validation: ValidationResult;
}

/**
 * Appends a new version.
 *
 * `expectedVersion` is the optimistic lock: two tabs editing the same design cannot silently
 * overwrite each other, and the loser is told which version to rebase onto.
 */
export async function saveDesign(
  sql: Sql,
  ctx: TenantContext,
  input: {
    designId: string;
    document: unknown;
    expectedVersion: number;
    name?: string;
    variantId?: string;
  },
): Promise<SaveResult> {
  const parsed = DesignDocument.safeParse(input.document);
  if (!parsed.success) {
    throw new DesignError(
      'invalid_document',
      'document does not match the schema',
      parsed.error.issues,
    );
  }

  const validation = await validateAgainstCatalog(sql, ctx, parsed.data);
  if (validation.errors.length > 0) {
    // An unrenderable design is never persisted: the editor blocks it too, and this is the guard
    // that holds when the editor is not the thing talking to us.
    throw new DesignError('invalid_document', 'design has blocking problems', validation.errors);
  }

  return withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    await assertDesignArtworkActive(tx, input.designId);
    await assertActiveArtworkReferences(tx, parsed.data);
    const [current] = await tx`
      select dv.version from designs d
      join design_versions dv on dv.id = d.current_version_id
      where d.id = ${input.designId} and d.deleted_at is null`;
    if (!current) throw new DesignError('not_found');

    const version = current['version'] as number;
    if (version !== input.expectedVersion) {
      throw new DesignError('version_conflict', `design is at version ${version}`, { version });
    }

    const versionId = uuidv7();
    await tx`
      insert into design_versions (id, design_id, org_id, version, schema_version, document, created_by)
      values (${versionId}, ${input.designId}, ${ctx.orgId}, ${version + 1}, ${CURRENT_SCHEMA_VERSION},
              ${sql.json(parsed.data as never)}, ${ctx.userId})`;
    await tx`
      update designs
      set current_version_id = ${versionId}, updated_at = now(),
          name = coalesce(${input.name ?? null}, name),
          product_variant_id = coalesce(${input.variantId ?? null}::uuid, product_variant_id)
      where id = ${input.designId}`;

    return { version: version + 1, validation };
  });
}

export async function renameDesign(
  sql: Sql,
  ctx: TenantContext,
  designId: string,
  name: string,
): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    await assertDesignArtworkActive(tx, designId);
    const rows = await tx`
      update designs set name = ${name}, updated_at = now()
      where id = ${designId} and deleted_at is null returning id`;
    if (rows.length === 0) throw new DesignError('not_found');
  });
}

/** Soft delete, with a restore window: deleting a week's work by mis-click should be survivable. */
export async function deleteDesign(sql: Sql, ctx: TenantContext, designId: string): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);

    const rows = await tx`
      update designs set deleted_at = now()
      where id = ${designId} and deleted_at is null returning id`;
    if (rows.length === 0) throw new DesignError('not_found');
  });
}

/**
 * Designs deleted recently enough to get back (F-PROJ-01).
 *
 * Deletion is soft and the window is finite: long enough that a mis-click on a Friday is
 * recoverable on Monday, short enough that "deleted" eventually means deleted.
 */
export const RESTORE_WINDOW_DAYS = 30;

export async function listDeletedDesigns(
  sql: Sql,
  ctx: TenantContext,
  limit = 20,
): Promise<DesignSummary[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select d.id, d.name, d.updated_at, d.deleted_at, d.thumbnail_key,
             dv.version, dv.document, p.name as product_name, v.name as variant_name
      from designs d
      join design_versions dv on dv.id = d.current_version_id
      join product_variants v on v.id = d.product_variant_id
      join products p on p.id = v.product_id
      where d.deleted_at is not null
        and d.deleted_at > now() - make_interval(days => ${RESTORE_WINDOW_DAYS})
      order by d.deleted_at desc
      limit ${limit}`;

    return Promise.all(
      rows.map(async (row) => ({
        archivedArtworks: await archivedArtworkReferences(tx, row['document'] as DesignDocument),
        id: row['id'] as string,
        name: row['name'] as string,
        version: row['version'] as number,
        productName: row['product_name'] as string,
        variantName: row['variant_name'] as string,
        updatedAt: (row['deleted_at'] as Date).toISOString(),
        thumbnailKey: (row['thumbnail_key'] as string | null) ?? null,
      })),
    );
  });
}

export async function restoreDesign(sql: Sql, ctx: TenantContext, designId: string): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);

    const rows = await tx`
      update designs set deleted_at = null
      where id = ${designId}
        and deleted_at is not null
        and deleted_at > now() - make_interval(days => ${RESTORE_WINDOW_DAYS})
      returning id`;
    if (rows.length === 0) throw new DesignError('not_found');
  });
}

/**
 * Records the picture the dashboard shows (F-PROJ-02).
 *
 * The bytes are already in storage by the time this is called; the row only learns where they are.
 * A thumbnail is a convenience, so a failure to make one must never stop a design being saved.
 */
export async function setDesignThumbnail(
  sql: Sql,
  ctx: TenantContext,
  designId: string,
  storageKey: string,
  write?: () => Promise<void>,
): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    await assertDesignArtworkActive(tx, designId);
    await write?.();
    const rows = await tx`
      update designs set thumbnail_key = ${storageKey}
      where id = ${designId} and deleted_at is null returning id`;
    if (rows.length === 0) throw new DesignError('not_found');
  });
}

export async function duplicateDesign(
  sql: Sql,
  ctx: TenantContext,
  designId: string,
): Promise<LoadedDesign> {
  const source = await loadDesign(sql, ctx, designId);

  return withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    await assertDesignArtworkActive(tx, designId);
    await assertActiveArtworkReferences(tx, source.document);
    const [variant] = await tx`select product_variant_id from designs where id = ${designId}`;
    const newId = uuidv7();
    const versionId = uuidv7();
    const name = `${source.name} (copy)`;

    await tx`
      insert into designs (id, org_id, name, product_variant_id, created_by)
      values (${newId}, ${ctx.orgId}, ${name}, ${variant!['product_variant_id']}, ${ctx.userId})`;
    await tx`
      insert into design_versions (id, design_id, org_id, version, schema_version, document, created_by)
      values (${versionId}, ${newId}, ${ctx.orgId}, 1, ${CURRENT_SCHEMA_VERSION},
              ${sql.json(source.document as never)}, ${ctx.userId})`;
    await tx`update designs set current_version_id = ${versionId} where id = ${newId}`;

    return {
      id: newId,
      name,
      version: 1,
      document: source.document,
      updatedAt: new Date().toISOString(),
    };
  });
}

// -----------------------------------------------------------------------------------------------

/** A design opens on the product's defaults: first material preset, no artwork, first camera. */
/**
 * Moves a design to another variant of the same product (F-CAT-04).
 *
 * A "38 mm" and a "45 mm" closure are the same product at two sizes, and the whole point of
 * variants is that a design made for one is nearly a design for the other. Placements carry over
 * where the target declares a zone by the same key, scaled down if the new zone is smaller and left
 * alone if it is not — the artwork keeps its size in millimetres wherever that still fits, because
 * a logo that silently grew with the cap is not the design anyone approved.
 *
 * A placement whose zone does not exist on the target is dropped rather than guessed at, and the
 * caller is told how many went.
 */
export interface VariantSwitch {
  document: DesignDocument;
  carried: number;
  dropped: number;
  version: number;
}

export async function switchVariant(
  sql: Sql,
  ctx: TenantContext,
  designId: string,
  variantId: string,
): Promise<VariantSwitch> {
  const target = await findVariant(sql, ctx, variantId);
  if (!target) throw new DesignError('unknown_variant', 'that product is not available');

  const current = await loadDesign(sql, ctx, designId);
  if (current.document.product.productKey !== target.productKey) {
    throw new DesignError(
      'unknown_variant',
      'a design can only move between variants of its own product',
    );
  }

  const zones = new Map(target.variant.zones.map((zone) => [zone.key, zone]));
  const kept: DesignDocument['placements'] = [];
  let dropped = 0;

  for (const placement of current.document.placements) {
    const zone = zones.get(placement.zoneKey);
    if (!zone) {
      dropped++;
      continue;
    }

    const extent = zoneExtentMm(zone);
    const available = {
      w: extent.w - extent.safeMarginMm * 2,
      h: extent.h - extent.safeMarginMm * 2,
    };
    const size = placement.transform.sizeMm;
    // Only shrink: growing artwork to fill a bigger zone would be inventing a decision.
    const scale = Math.min(
      1,
      available.w / Math.max(size.w, 0.001),
      available.h / Math.max(size.h, 0.001),
    );

    kept.push({
      ...placement,
      transform: {
        ...placement.transform,
        sizeMm: { w: size.w * scale, h: size.h * scale },
        offsetMm: {
          x: clamp(placement.transform.offsetMm.x * scale, (available.w - size.w * scale) / 2),
          y: clamp(placement.transform.offsetMm.y * scale, (available.h - size.h * scale) / 2),
        },
      },
      finish:
        'depthMm' in placement.finish
          ? {
              ...placement.finish,
              depthMm: Math.min(placement.finish.depthMm, zone.constraints.maxDepthMm),
            }
          : placement.finish,
    });
  }

  // Material assignments follow their slot key; a slot the target does not declare goes, and one it
  // declares that the design never had takes the pack's default.
  const materials: DesignDocument['materials'] = {};
  for (const slot of target.variant.materialSlots) {
    materials[slot.key] = current.document.materials[slot.key] ?? {
      materialKey: slot.defaultMaterialKey,
      textureScale: 1,
      textureRotationDeg: 0,
    };
  }

  const document = DesignDocument.parse({
    ...current.document,
    product: {
      packKey: target.packKey,
      packVersion: target.packVersion,
      productKey: target.productKey,
      variantKey: target.variant.key,
    },
    materials,
    placements: kept,
    scene: {
      ...current.document.scene,
      // A source-space override belongs to one variant; another may use unrelated CAD axes.
      presentationOrientationOverride: undefined,
      camera: target.variant.cameraPresets.some(
        (preset) =>
          current.document.scene.camera.kind === 'preset' &&
          preset.key === current.document.scene.camera.presetKey,
      )
        ? current.document.scene.camera
        : { kind: 'preset', presetKey: target.variant.cameraPresets[0]?.key ?? 'three-quarter' },
    },
  });

  const saved = await saveDesign(sql, ctx, {
    designId,
    document,
    expectedVersion: current.version,
    variantId,
  });

  return { document, carried: kept.length, dropped, version: saved.version };
}

const clamp = (value: number, limit: number): number =>
  Math.min(Math.max(value, -Math.abs(limit)), Math.abs(limit));

export function defaultDocument(
  variant: CatalogVariant,
  packKey: string,
  packVersion: string,
  productKey: string,
): DesignDocument {
  const materials = Object.fromEntries(
    variant.materialSlots.map((slot) => [
      slot.key,
      { materialKey: slot.defaultMaterialKey, textureScale: 1, textureRotationDeg: 0 },
    ]),
  );

  return DesignDocument.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    units: 'mm',
    product: { packKey, packVersion, productKey, variantKey: variant.key },
    materials,
    placements: [],
    scene: {
      environmentKey: 'studio-softbox',
      environmentRotationDeg: 0,
      exposureEv: 0,
      background: { kind: 'studio' },
      camera: { kind: 'preset', presetKey: variant.cameraPresets[0]?.key ?? 'three-quarter' },
    },
    annotations: {},
  });
}

interface ResolvedVariant {
  variant: CatalogVariant;
  packKey: string;
  packVersion: string;
  productKey: string;
  productName: string;
}

async function findVariant(
  sql: Sql,
  ctx: TenantContext,
  variantId: string,
): Promise<ResolvedVariant | null> {
  for (const product of await listProducts(sql, ctx, { limit: 200 })) {
    const variant = product.variants.find((v) => v.variantId === variantId);
    if (variant) {
      return {
        variant,
        packKey: product.packKey,
        packVersion: product.packVersion,
        productKey: product.productKey,
        productName: product.name,
      };
    }
  }
  return null;
}

/**
 * Runs the same validation the editor runs, against the catalog the document claims to be built on.
 *
 * Artwork statistics are not consulted here — they live with the artwork records and the placement
 * checks that need them run in the editor; what the server insists on is that zones, finishes,
 * depths and materials are real and within limits.
 */
async function validateAgainstCatalog(
  sql: Sql,
  ctx: TenantContext,
  document: DesignDocument,
): Promise<ValidationResult> {
  // The version the document was made on, not whichever version is live: a zone removed in a newer
  // version is still a zone on this one.
  const product = await getDesignProduct(sql, ctx, document.product);
  const variant = product?.variants.find((v) => v.key === document.product.variantKey);

  if (!variant) {
    return {
      errors: [
        {
          severity: 'error',
          code: 'zone_unknown',
          message: `product ${document.product.productKey} is not available`,
        },
      ],
      warnings: [],
    };
  }

  const zones: Record<string, DecorationZoneDef> = Object.fromEntries(
    variant.zones.map((zone) => [zone.key, zone]),
  );
  const materialSlots = Object.fromEntries(
    variant.materialSlots.map((slot) => [
      slot.key,
      { allowedFamilies: [] as string[], colorizable: slot.colorizable },
    ]),
  );
  const materials = await loadMaterials(sql, ctx);

  return validateDesign(document, {
    zones,
    materialSlots,
    materials,
    // Placement geometry is checked; stroke widths and coverage need the artwork record, and the
    // editor has already refused anything that fails them.
    artwork: Object.fromEntries(
      document.placements.map((placement) => [
        placement.artwork.versionId,
        {
          pathCount: 1,
          nodeCount: 1,
          naturalSizeMm: placement.transform.sizeMm,
          contentBbox: { x: 0, y: 0, ...placement.transform.sizeMm },
          minStrokeMm: null,
          coverage: 0,
          hasText: false,
          hasGradients: false,
          hasClipPaths: false,
        },
      ]),
    ),
  });
}

async function loadMaterials(
  sql: Sql,
  ctx: TenantContext,
): Promise<Record<string, { family: string; colorizable: boolean }>> {
  return withTenant(sql, ctx, async (tx: Tx) => {
    const rows = await tx`select key, family, definition from materials where status = 'published'`;
    return Object.fromEntries(
      rows.map((row) => [
        row['key'] as string,
        {
          family: row['family'] as string,
          colorizable: (row['definition'] as MaterialDefinition).colorizable ?? true,
        },
      ]),
    );
  });
}
