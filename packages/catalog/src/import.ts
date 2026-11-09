import { createHash } from 'node:crypto';
import { recordAudit, uuidv7, withStaff, type Sql, type Tx } from '@pr/db';
import {
  validatePack,
  type DecorationZoneDef,
  type PackManifest,
  type ProductVariantDef,
} from '@pr/design-schema';
import { retireOtherVersions } from './retire.js';

/**
 * Product Pack import (F-GEN-02, W-15).
 *
 * A pack is the only way a product enters the catalog, so this is the only writer of the catalog
 * tables. It is idempotent per (key, version): importing the same pack twice is a no-op, and
 * publishing a new version leaves the old one — and every design pinned to it — alone.
 */

export interface ImportOptions {
  /** Publish immediately, or leave the pack in draft for staff review (the default). */
  publish?: boolean;
  /** Restrict visibility to these organisations. Absent means visible to everyone. */
  visibleToOrgIds?: string[];
  createdBy?: string | null;
  /**
   * Where the pack's files live, and where to put them.
   *
   * A pack is a manifest *and* its assets. Without this the catalog records storage keys that
   * nothing can resolve, and every reader needs a private fallback to the directory the pack came
   * from — which is how a renderer ends up unable to find a mesh the catalog swears exists.
   */
  assets?: {
    read: (path: string) => Promise<Uint8Array>;
    write: (storageKey: string, bytes: Uint8Array) => Promise<void>;
  };
  /**
   * Overwrite a published or deprecated version with different contents, deliberately.
   *
   * Without it such an import is refused: a published version is what designs are built on, and
   * rewriting it in place moves their zones underneath them. A draft never needs this. Even with it,
   * a zone that a design places artwork in cannot be dropped.
   */
  replace?: boolean;
}

export interface ImportResult {
  packId: string;
  key: string;
  version: string;
  status: 'created' | 'unchanged' | 'replaced';
  products: number;
  variants: number;
  zones: number;
  materials: number;
  issues: ReturnType<typeof validatePack>['issues'];
}

export class PackImportError extends Error {
  constructor(
    message: string,
    readonly issues: ReturnType<typeof validatePack>['issues'] = [],
  ) {
    super(message);
    this.name = 'PackImportError';
  }
}

export async function importPack(
  sql: Sql,
  raw: unknown,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const validation = validatePack(raw);
  if (!validation.publishable) {
    throw new PackImportError(
      `pack has ${validation.errors.length} blocking problem(s)`,
      validation.issues,
    );
  }

  const manifest = validation.manifest;
  if (
    options.publish &&
    manifest.products.some((p) =>
      p.variants.some((v) => v.presentationOrientation && !v.presentationOrientation.confirmed),
    )
  ) {
    throw new PackImportError('Confirm product orientation before publishing.');
  }
  const digest = createHash('sha256').update(canonical(manifest)).digest();

  return withStaff(sql, async (tx) => {
    const [existing] = await tx`
      select id, digest, status from product_packs
      where key = ${manifest.key} and version = ${manifest.version}`;

    if (existing && Buffer.from(existing['digest'] as Buffer).equals(digest)) {
      // The rows are already right, but the files may not be — a fresh storage volume, or an
      // import that ran before assets were copied at all. Re-importing is the obvious way to fix
      // that, so it has to actually fix it.
      await ensureAssets(manifest, options.assets);
      return {
        packId: existing['id'] as string,
        key: manifest.key,
        version: manifest.version,
        status: 'unchanged' as const,
        ...counts(manifest),
        issues: validation.issues,
      };
    }

    // Changed contents under a version that is (or was) live: never a silent overwrite (W-15). Found
    // by re-importing a published pack with a zone removed — the importer said "replaced", and every
    // design on that zone stopped saving.
    if (existing && existing['status'] !== 'draft' && !options.replace) {
      const label = `${manifest.key}@${manifest.version}`;
      const message =
        `${label} is already ${existing['status'] as string} and these contents are different. A published ` +
        'version is what designs are built on, so it is never rewritten: give this pack a new version ' +
        'number (or, from the command line, --replace to overwrite it on purpose).';
      throw new PackImportError(message, [
        { severity: 'error', code: 'version_exists', path: label, message },
      ]);
    }

    if (existing) await assertZonesKept(tx, existing['id'] as string, manifest);

    // Replacing a version rewrites its rows, and designs reference a variant by id — so the
    // designs have to be carried across by key, not left pointing at rows that no longer exist.
    const attached = existing
      ? await tx`
          select d.id, p.key as product_key, v.key as variant_key
          from designs d
          join product_variants v on v.id = d.product_variant_id
          join products p on p.id = v.product_id
          where p.pack_id = ${existing['id']}`
      : [];

    if (existing) {
      // The designs are moved after the new rows exist, so the reference is briefly to a row that
      // is being deleted. Deferring the check to commit is what makes that one transaction.
      if (attached.length > 0) await tx`set constraints designs_product_variant_id_fkey deferred`;
      await tx`delete from product_packs where id = ${existing['id']}`;
    }

    const variantIds = new Map<string, string>();
    const packId = uuidv7();
    await tx`
      insert into product_packs (id, key, version, name, status, manifest, digest, created_by, published_at)
      values (${packId}, ${manifest.key}, ${manifest.version}, ${manifest.name},
              ${options.publish ? 'published' : 'draft'}, ${sql.json(manifest as never)}, ${digest},
              ${options.createdBy ?? null}, ${options.publish ? new Date() : null})`;

    for (const orgId of options.visibleToOrgIds ?? []) {
      await tx`insert into pack_visibility (pack_id, org_id) values (${packId}, ${orgId})`;
    }
    if (options.publish) await retireOtherVersions(tx, packId, options.createdBy ?? null);

    for (const material of manifest.materials) {
      // Texture paths are pack-relative in the manifest and storage keys once imported, exactly as
      // meshes are. A definition that kept the authored path would send the renderer looking for a
      // file inside a directory that only ever existed on whoever authored the pack's machine.
      const stored = withStoredTexturePaths(manifest, material);
      await tx`
        insert into materials (id, org_id, key, name, family, definition, version, status)
        values (${uuidv7()}, null, ${material.key}, ${material.name}, ${material.family},
                ${sql.json(stored as never)}, ${material.version}, 'published')
        on conflict do nothing`;
    }

    for (const [index, product] of manifest.products.entries()) {
      const productId = uuidv7();
      await tx`
        insert into products (id, pack_id, key, name, category, facets, sort, status)
        values (${productId}, ${packId}, ${product.key}, ${product.name}, ${product.category},
                ${sql.json(product.facets as never)}, ${index},
                ${options.publish ? 'published' : 'draft'})`;

      for (const variant of product.variants) {
        const variantId = await insertVariant(
          tx,
          sql,
          productId,
          variant,
          manifest,
          options.assets,
        );
        variantIds.set(`${product.key}/${variant.key}`, variantId);
      }
    }

    // Every design that was on this pack version moves to the row that replaced its variant. One
    // that no longer has a variant to move to stops the import: silently orphaning someone's work
    // is not a thing an import should be able to do.
    const orphaned: string[] = [];
    for (const design of attached) {
      const key = `${design['product_key']}/${design['variant_key']}`;
      const variantId = variantIds.get(key);
      if (!variantId) {
        orphaned.push(key);
        continue;
      }
      await tx`update designs set product_variant_id = ${variantId} where id = ${design['id']}`;
    }

    if (orphaned.length > 0) {
      throw new PackImportError(
        `this version no longer contains ${[...new Set(orphaned)].join(', ')}, ` +
          'which existing designs are built on',
        [...new Set(orphaned)].map((key) => ({
          severity: 'error' as const,
          code: 'asset_missing' as const,
          path: key,
          message: `designs exist for ${key}, which the new manifest does not define`,
        })),
      );
    }

    return {
      packId,
      key: manifest.key,
      version: manifest.version,
      status: existing ? ('replaced' as const) : ('created' as const),
      ...counts(manifest),
      issues: validation.issues,
    };
  });
}

async function insertVariant(
  tx: Tx,
  sql: Sql,
  productId: string,
  variant: ProductVariantDef,
  manifest: PackManifest,
  assetStore: ImportOptions['assets'],
): Promise<string> {
  const variantId = uuidv7();
  await tx`
    insert into product_variants (id, product_id, key, name, dimensions_mm, material_slots,
                                  camera_presets, capabilities)
    values (${variantId}, ${productId}, ${variant.key}, ${variant.name},
            ${sql.json(variant.dimensionsMm as never)}, ${sql.json(variant.materialSlots as never)},
            ${sql.json(variant.cameraPresets as never)}, ${sql.json(variant.capabilities as never)})`;

  const assets: [string, { path: string; digest?: string; bytes?: number } | undefined][] = [
    ['lod0', variant.assets.lod0],
    ['lod1', variant.assets.lod1],
    ['render_mesh', variant.assets.renderMesh],
    ['thumbnail', variant.assets.thumbnail],
  ];

  for (const [kind, asset] of assets) {
    if (!asset) continue;
    const key = storageKey(manifest, asset.path);

    // The bytes go where the key says they are. A catalog row pointing at nothing is worse than no
    // row at all: it fails at render time, on someone else's machine, hours later.
    let bytes = asset.bytes ?? 0;
    if (assetStore) {
      const file = await readDeclaredAsset(assetStore, asset.path);
      await assetStore.write(key, file);
      bytes = file.byteLength;
    }

    await tx`
      insert into product_assets (id, variant_id, kind, storage_key, digest, bytes, meta)
      values (${uuidv7()}, ${variantId}, ${kind}, ${key},
              ${asset.digest ? Buffer.from(asset.digest, 'hex') : Buffer.alloc(32)},
              ${bytes}, '{}'::jsonb)`;
  }

  for (const [index, zone] of variant.zones.entries()) {
    await tx`
      insert into decoration_zones (id, variant_id, key, name, type, frame, size_mm, uv_rect,
                                    constraints, sort)
      values (${uuidv7()}, ${variantId}, ${zone.key}, ${zone.name}, ${zone.type},
              ${frameOf(zone) ? sql.json(frameOf(zone) as never) : null},
              ${sql.json(zone.sizeMm as never)},
              ${uvRectOf(zone) ? sql.json(uvRectOf(zone) as never) : null},
              ${sql.json(zone.constraints as never)}, ${index})`;
  }

  return variantId;
}

/**
 * Refuses a replacement that drops a zone a design places artwork in.
 *
 * The variant check further down only notices a whole variant disappearing; a zone going quietly
 * left the design pointing at nothing, so it could be opened but never saved again.
 */
async function assertZonesKept(tx: Tx, packId: string, manifest: PackManifest): Promise<void> {
  const used = await tx`
    select d.name, pr.key as product_key, v.key as variant_key, p.placement ->> 'zoneKey' as zone_key
    from designs d
    join design_versions dv on dv.id = d.current_version_id
    join product_variants v on v.id = d.product_variant_id
    join products pr on pr.id = v.product_id
    cross join lateral jsonb_array_elements(dv.document -> 'placements') as p(placement)
    where pr.pack_id = ${packId} and d.deleted_at is null`;

  const kept = new Set(
    manifest.products.flatMap((product) =>
      product.variants.flatMap((variant) =>
        variant.zones.map((zone) => `${product.key}/${variant.key}/${zone.key}`),
      ),
    ),
  );
  const lost = used.filter(
    (row) => !kept.has(`${row['product_key']}/${row['variant_key']}/${row['zone_key']}`),
  );
  if (lost.length === 0) return;

  const zones = [
    ...new Set(lost.map((row) => `${row['product_key']}/${row['variant_key']}/${row['zone_key']}`)),
  ];
  const designs = [...new Set(lost.map((row) => `"${row['name'] as string}"`))];
  throw new PackImportError(
    `this version drops ${zones.join(', ')}, which ${designs.length === 1 ? 'a design places' : `${designs.length} designs place`} ` +
      `artwork in (${designs.slice(0, 3).join(', ')}${designs.length > 3 ? ', …' : ''})`,
    zones.map((zone) => ({
      severity: 'error' as const,
      code: 'asset_missing' as const,
      path: zone,
      message: `designs place artwork in ${zone}, which the new manifest does not define`,
    })),
  );
}

const frameOf = (zone: DecorationZoneDef) => ('frame' in zone ? zone.frame : null);
const uvRectOf = (zone: DecorationZoneDef) => ('uvRect' in zone ? (zone.uvRect ?? null) : null);

/**
 * Reads a file the manifest promised.
 *
 * A pack that names a file it does not ship is broken, and the import is the last place anyone is
 * watching. Refusing here costs a re-export; letting it through costs a render that fails at 2am.
 */
async function readDeclaredAsset(
  assets: NonNullable<ImportOptions['assets']>,
  path: string,
): Promise<Uint8Array> {
  try {
    return await assets.read(path);
  } catch {
    throw new PackImportError(`the pack declares ${path} but does not contain it`, [
      { severity: 'error', code: 'asset_missing', path, message: `missing pack file: ${path}` },
    ]);
  }
}

/** Writes any pack file that is not already in storage. */
async function ensureAssets(
  manifest: PackManifest,
  assets: ImportOptions['assets'],
): Promise<void> {
  if (!assets) return;

  for (const product of manifest.products) {
    for (const variant of product.variants) {
      const paths = [
        variant.assets.lod0,
        variant.assets.lod1,
        variant.assets.renderMesh,
        variant.assets.thumbnail,
      ];
      for (const asset of paths) {
        if (!asset) continue;
        await assets.write(
          storageKey(manifest, asset.path),
          await readDeclaredAsset(assets, asset.path),
        );
      }
    }
  }

  // Texture sets are pack files too, and the renderer will ask storage for them by key.
  for (const material of manifest.materials) {
    for (const [slot, reference] of Object.entries(material.maps)) {
      if (slot === 'tilingMm' || !reference || typeof reference !== 'object') continue;
      const path = (reference as { path: string }).path;
      await assets.write(storageKey(manifest, path), await readDeclaredAsset(assets, path));
    }
  }
}

/** Storage keys follow docs/11-data-model.md so assets are addressable without a lookup table. */
export const storageKey = (manifest: PackManifest, path: string): string =>
  `packs/${manifest.key}/${manifest.version}/${path}`;

const counts = (manifest: PackManifest) => ({
  products: manifest.products.length,
  variants: manifest.products.reduce((n, p) => n + p.variants.length, 0),
  zones: manifest.products.reduce(
    (n, p) => n + p.variants.reduce((m, v) => m + v.zones.length, 0),
    0,
  ),
  materials: manifest.materials.length,
});

/** Stable serialisation, so an unchanged pack hashes to an unchanged digest. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The next version to draft after `version`: one minor step up, patch reset.
 *
 * Minor rather than patch because moving a zone changes where a logo lands, which is more than a
 * fix; a major step would claim a break nobody decided on.
 */
export function nextDraftVersion(version: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const match = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (!match) throw new PackImportError(`"${version}" is not a version this can count on from`);
  const major = Number(match[1]);
  for (let minor = Number(match[2]) + 1; ; minor++) {
    const candidate = `${major}.${minor}.0`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * A new draft version of a pack, with everything the old one had (F-ADM-13) — or the draft that
 * already exists, if there is one.
 *
 * How a published pack's zones get changed: never in place, because designs point at the published
 * version and moving a zone underneath one moves its logo. The copy goes through `importPack` like
 * every other pack, so it is validated, its meshes are written under its own version's keys, and
 * the old version and every design on it are left exactly as they were. Visibility carries over;
 * status does not — the copy is a draft until someone publishes it.
 */
export async function createDraftVersion(
  sql: Sql,
  packId: string,
  storage: {
    read: (storageKey: string) => Promise<Uint8Array>;
    write: (storageKey: string, bytes: Uint8Array) => Promise<void>;
  },
  actorId: string | null,
): Promise<ImportResult> {
  const source = await withStaff(sql, async (tx) => {
    const [pack] = await tx`select key, version, manifest from product_packs where id = ${packId}`;
    if (!pack) throw new PackImportError('no such pack');
    const versions = await tx`
      select id, version, status, manifest from product_packs where key = ${pack['key']}
      order by created_at desc`;
    const visibility = await tx`select org_id from pack_visibility where pack_id = ${packId}`;
    return {
      manifest: pack['manifest'] as PackManifest,
      taken: versions.map((row) => row['version'] as string),
      openDraft: versions.find((row) => row['status'] === 'draft' && row['id'] !== packId),
      visibleToOrgIds: visibility.map((row) => row['org_id'] as string),
    };
  });

  // One draft at a time. A second click, or a second person, gets the draft already in progress
  // rather than a third version nobody meant to make — two drafts of one pack diverge, and only one
  // of them can ever be published without undoing the other.
  if (source.openDraft) {
    const draft = source.openDraft['manifest'] as PackManifest;
    return {
      packId: source.openDraft['id'] as string,
      key: draft.key,
      version: draft.version,
      status: 'unchanged',
      ...counts(draft),
      issues: [],
    };
  }

  const version = nextDraftVersion(source.manifest.version, source.taken);
  const manifest = { ...structuredClone(source.manifest), version };
  const result = await importPack(sql, manifest, {
    createdBy: actorId,
    visibleToOrgIds: source.visibleToOrgIds,
    assets: {
      read: (path) => storage.read(storageKey(source.manifest, path)),
      write: storage.write,
    },
  });

  await withStaff(sql, (tx) =>
    recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'pack.version_drafted',
      targetType: 'product_pack',
      targetId: result.packId,
      metadata: { key: manifest.key, from: source.manifest.version, to: manifest.version },
    }),
  );

  return result;
}

/** Publishes a draft pack, making it visible to the organisations it is scoped to. */
export async function publishPack(sql: Sql, packId: string): Promise<void> {
  await withStaff(sql, async (tx) => {
    await tx`update product_packs set status = 'published', published_at = now() where id = ${packId}`;
    await tx`update products set status = 'published' where pack_id = ${packId}`;
    await retireOtherVersions(tx, packId, null);
  });
}

export async function deprecatePack(sql: Sql, packId: string): Promise<void> {
  await withStaff(sql, async (tx) => {
    await tx`update product_packs set status = 'deprecated' where id = ${packId}`;
    await tx`update products set status = 'deprecated' where pack_id = ${packId}`;
  });
}

/** A material whose texture references point at storage keys rather than at the author's folder. */
function withStoredTexturePaths(
  manifest: PackManifest,
  material: PackManifest['materials'][number],
): PackManifest['materials'][number] {
  const maps: Record<string, unknown> = { ...material.maps };
  let changed = false;

  for (const [slot, value] of Object.entries(maps)) {
    if (!value || typeof value !== 'object' || !('path' in value)) continue;
    const reference = value as { path: string };
    maps[slot] = { ...reference, path: storageKey(manifest, reference.path) };
    changed = true;
  }

  return changed ? { ...material, maps: maps as typeof material.maps } : material;
}
