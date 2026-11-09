import { withTenant, type Sql, type TenantContext, type Tx } from '@pr/db';
import type { CameraPresetDef } from '@pr/scene';
import { PackManifest } from '@pr/design-schema';
import type { PresentationOrientation } from '@pr/design-schema';
import type { DecorationZoneDef, MaterialDefinition, Vec3 } from '@pr/design-schema';

/**
 * Catalog reads.
 *
 * Every query runs inside the caller's tenant context, so pack visibility is enforced by the same
 * policies that protect their designs rather than by remembering to add a filter here.
 */

export interface CatalogProduct {
  packKey: string;
  packVersion: string;
  productKey: string;
  name: string;
  category: string;
  facets: Record<string, string | number | boolean>;
  variants: CatalogVariant[];
}

export interface CatalogVariant {
  variantId: string;
  key: string;
  name: string;
  bboxMm: [Vec3, Vec3];
  materialSlots: { key: string; label: string; defaultMaterialKey: string; colorizable: boolean }[];
  cameraPresets: CameraPresetDef[];
  presentationOrientation?: PresentationOrientation;
  capabilities: Record<string, boolean>;
  zones: DecorationZoneDef[];
  assets: Partial<Record<'lod0' | 'lod1' | 'render_mesh' | 'thumbnail', string>>;
}

export interface ListProductsFilter {
  category?: string;
  search?: string;
  /**
   * Facet values to match, by facet name (F-CAT-02).
   *
   * Which facets exist is a pack's business, not ours — "neck size" means nothing to a carton — so
   * this filters on whatever keys the manifests happen to declare rather than on a fixed list.
   */
  facets?: Record<string, string>;
  limit?: number;
}

/** The facets present across a set of products, with the values each one takes. */
export interface FacetSummary {
  key: string;
  values: { value: string; count: number }[];
}

export function summariseFacets(products: CatalogProduct[]): FacetSummary[] {
  const seen = new Map<string, Map<string, number>>();

  for (const product of products) {
    for (const [key, value] of Object.entries(product.facets)) {
      const text = String(value);
      const values = seen.get(key) ?? new Map<string, number>();
      values.set(text, (values.get(text) ?? 0) + 1);
      seen.set(key, values);
    }
  }

  return [...seen.entries()]
    .map(([key, values]) => ({
      key,
      values: [...values.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export async function listProducts(
  sql: Sql,
  ctx: TenantContext,
  filter: ListProductsFilter = {},
): Promise<CatalogProduct[]> {
  const limit = Math.min(filter.limit ?? 100, 200);

  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select
        pk.key as pack_key, pk.version as pack_version,
        p.key as product_key, p.name as product_name, p.category, p.facets,
        v.id as variant_id, v.key as variant_key, v.name as variant_name,
        v.dimensions_mm, v.material_slots, v.camera_presets, v.capabilities, pk.manifest
      from product_packs pk
      join products p on p.pack_id = pk.id
      join product_variants v on v.product_id = p.id
      where pk.status = 'published' and p.status = 'published'
        ${filter.category ? tx`and p.category = ${filter.category}` : tx``}
        ${filter.search ? tx`and (p.name ilike ${'%' + filter.search + '%'} or p.key ilike ${'%' + filter.search + '%'})` : tx``}
        ${
          // Compared as text, not by JSON containment: a manifest may write a neck size as 38 or as
          // "38", and a filter that only matched one of them would silently show nothing.
          Object.entries(filter.facets ?? {}).reduce(
            (clause, [key, value]) => tx`${clause} and p.facets ->> ${key} = ${value}`,
            tx``,
          )
        }
      order by p.sort, p.key, v.key
      limit ${limit}`;

    return assemble(tx, rows);
  });
}

/** Catalog rows (one per variant) into products, with each variant's zones and assets. */
async function assemble(
  tx: Tx,
  rows: readonly Record<string, unknown>[],
): Promise<CatalogProduct[]> {
  if (rows.length === 0) return [];

  const variantIds = rows.map((r) => r['variant_id'] as string);
  const zones = await tx`
    select variant_id, key, name, type, frame, size_mm, uv_rect, constraints
    from decoration_zones where variant_id in ${tx(variantIds)} order by sort`;
  const assets = await tx`
    select variant_id, kind, storage_key
    from product_assets where variant_id in ${tx(variantIds)} and kind <> 'thumbnail'
    union all
    select v.id as variant_id, 'thumbnail' as kind, coalesce(t.storage_key,a.storage_key) as storage_key
    from product_variants v
    left join catalog_thumbnails t on t.variant_id = v.id
    left join product_assets a on a.variant_id = v.id and a.kind = 'thumbnail'
    where v.id in ${tx(variantIds)} and coalesce(t.storage_key,a.storage_key) is not null`;

  const products = new Map<string, CatalogProduct>();

  for (const row of rows) {
    // Keyed by version as well: two versions of one pack are two products, never one product with
    // both versions' variants — which is how a catalog offered the same size twice, and checked a
    // design against zones its own version never had.
    const productId = `${row['pack_key']}@${row['pack_version']}/${row['product_key']}`;
    const product = products.get(productId) ?? {
      packKey: row['pack_key'] as string,
      packVersion: row['pack_version'] as string,
      productKey: row['product_key'] as string,
      name: row['product_name'] as string,
      category: row['category'] as string,
      facets: row['facets'] as Record<string, string | number | boolean>,
      variants: [],
    };

    const variantId = row['variant_id'] as string;
    const authored = PackManifest.parse(row['manifest'])
      .products.find((p) => p.key === row['product_key'])
      ?.variants.find((v) => v.key === row['variant_key']);
    product.variants.push({
      variantId,
      key: row['variant_key'] as string,
      name: row['variant_name'] as string,
      bboxMm: (row['dimensions_mm'] as { bbox: [Vec3, Vec3] }).bbox,
      materialSlots: row['material_slots'] as CatalogVariant['materialSlots'],
      cameraPresets: row['camera_presets'] as CameraPresetDef[],
      presentationOrientation: authored?.presentationOrientation,
      capabilities: row['capabilities'] as Record<string, boolean>,
      zones: zones
        .filter((z) => z['variant_id'] === variantId)
        .map((z) => {
          const target = authored?.zones.find((zone) => zone.key === z['key'])?.materialSlotKey;
          return { ...toZoneDefinition(z), ...(target ? { materialSlotKey: target } : {}) };
        }),
      assets: Object.fromEntries(
        assets
          .filter((a) => a['variant_id'] === variantId)
          .map((a) => [a['kind'] as string, a['storage_key'] as string]),
      ),
    });

    products.set(productId, product);
  }

  return [...products.values()];
}

/**
 * The exact product a design was made on, published or retired (F-ADM-13).
 *
 * A design names its pack *version*, and that is the one it is checked, drawn and rendered
 * against — never whichever version happens to be live now. A retired (deprecated) version stays
 * readable here for the designs built on it, which is what deprecating has always promised; it just
 * stops being offered for new ones. Visibility still applies: this is the tenant's view.
 */
export async function getDesignProduct(
  sql: Sql,
  ctx: TenantContext,
  ref: { packKey: string; packVersion: string; productKey: string },
): Promise<CatalogProduct | null> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select
        pk.key as pack_key, pk.version as pack_version,
        p.key as product_key, p.name as product_name, p.category, p.facets,
        v.id as variant_id, v.key as variant_key, v.name as variant_name,
        v.dimensions_mm, v.material_slots, v.camera_presets, v.capabilities, pk.manifest
      from product_packs pk
      join products p on p.pack_id = pk.id
      join product_variants v on v.product_id = p.id
      where pk.key = ${ref.packKey} and pk.version = ${ref.packVersion} and p.key = ${ref.productKey}
        and pk.status in ('published', 'deprecated') and p.status in ('published', 'deprecated')
      order by v.key`;
    return (await assemble(tx, rows))[0] ?? null;
  });
}

export async function getVariant(
  sql: Sql,
  ctx: TenantContext,
  variantId: string,
): Promise<CatalogVariant | null> {
  const products = await listProducts(sql, ctx, { limit: 200 });
  for (const product of products) {
    const variant = product.variants.find((v) => v.variantId === variantId);
    if (variant) return variant;
  }
  return null;
}

export interface CatalogMaterial {
  key: string;
  name: string;
  family: string;
  definition: MaterialDefinition;
}

/**
 * Every published material the caller can use.
 *
 * Materials are pack-scoped in the manifest but global in the catalog: two packs may both ship a
 * `board-coated`, and the importer settles that by key, so a design that names one gets the same
 * definition wherever it was declared.
 */
export async function listMaterials(sql: Sql, ctx: TenantContext): Promise<CatalogMaterial[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select key, name, family, definition from materials
      where status = 'published' order by key`;
    return rows.map((row) => ({
      key: row['key'] as string,
      name: row['name'] as string,
      family: row['family'] as string,
      definition: row['definition'] as MaterialDefinition,
    }));
  });
}

/** Rebuilds the discriminated union the schema defines from the row's columns. */
function toZoneDefinition(row: Record<string, unknown>): DecorationZoneDef {
  const base = {
    key: row['key'] as string,
    name: row['name'] as string,
    sizeMm: row['size_mm'],
    constraints: row['constraints'],
  };
  const type = row['type'] as DecorationZoneDef['type'];

  switch (type) {
    case 'planar':
    case 'conformal':
      return {
        ...base,
        type,
        frame: row['frame'],
        uvRect: row['uv_rect'] ?? undefined,
      } as DecorationZoneDef;
    case 'cylindrical':
      return { ...base, type, frame: row['frame'] } as DecorationZoneDef;
    case 'uv_rect':
      return { ...base, type, uvSet: 'decor', uvRect: row['uv_rect'] } as DecorationZoneDef;
    case 'flat_panel':
      return {
        ...base,
        type,
        panelId: (row['frame'] as { panelId?: string } | null)?.panelId ?? base.key,
        uvRect: row['uv_rect'],
      } as DecorationZoneDef;
  }
}
