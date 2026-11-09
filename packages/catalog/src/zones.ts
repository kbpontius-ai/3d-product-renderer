import { setupRevision } from './orientation.js';
import type { PresentationOrientation, ProductVariantDef } from '@pr/design-schema';
import { recordAudit, uuidv7, withStaff, type Sql, type Tx } from '@pr/db';
import {
  DecorationZoneDef,
  validatePack,
  zoneExtentMm,
  type PackIssue,
  type PackManifest,
  type Vec3,
} from '@pr/design-schema';

/**
 * Zone authoring (F-ADM-02, F-ADM-13).
 *
 * A zone is a claim: this rectangle of millimetres, on this part of this mesh, is where artwork
 * goes. A pack made from an upload arrives with none, and a person makes every one of those claims
 * here — nothing proposes where a zone should go, because a plausible wrong guess gets accepted
 * without being read. Packs that do arrive with zones are usually a little wrong the first time: a
 * safe margin that crowds the artwork, a depth limit the tooling cannot hold, a size measured from
 * the wrong drawing.
 *
 * Edits are applied to the stored manifest, not only to the derived rows: the manifest is what the
 * pack *is*, what a re-import compares against, and what an operator would export to send back to
 * whoever authored it. The rows are then brought into line in the same transaction, because a
 * catalog that disagrees with its own manifest is worse than either version alone.
 */

export interface ZoneView {
  productKey: string;
  productName: string;
  variantKey: string;
  variantName: string;
  variantId: string;
  zone: DecorationZoneDef;
  /** Width, height and margin in millimetres, whatever the zone's type. */
  extentMm: { w: number; h: number; safeMarginMm: number };
}

export interface ZoneAddress {
  packId: string;
  productKey: string;
  variantKey: string;
  zoneKey: string;
}

/**
 * The fields worth changing after a pack is authored.
 *
 * `frame` is where the zone sits on the part, and it moves only on a draft (F-ADM-13): a published
 * version is what customers' designs point at, and moving a zone underneath a design moves its
 * logo. Flat/surface mapping may change only on an unused draft zone.
 */
export interface ZonePatch {
  mapping?: 'planar' | 'conformal';
  frame?: unknown;
  materialSlotKey?: string | null;
  name?: string;
  widthMm?: number;
  heightMm?: number;
  safeMarginMm?: number;
  finishes?: DecorationZoneDef['constraints']['finishes'];
  maxDepthMm?: number;
  minStrokeMm?: number;
  maxCoverage?: number;
  wrapWarnDeg?: number;
}

/**
 * A refusal as a sentence for the person who asked.
 *
 * Validation issues carry a path so a program can find the field; a path into the pack
 * ("products.cap-flat.38mm.top") says nothing to the author, who knows which zone they just saved.
 * Field paths from the schema ("frame.tangent") are kept, because they do name the box that is wrong.
 */
export function describeZoneEditError(error: ZoneEditError): string {
  if (error.issues.length === 0) return error.message;
  const details = error.issues.map((issue) =>
    issue.path && !issue.path.startsWith('products.')
      ? `${issue.path} ${issue.message}`
      : issue.message,
  );
  return `${error.message}: ${details.join('; ')}`;
}

/** What kind of refusal, so the route can answer 404, 409 or 422 without parsing a message. */
export type ZoneEditCode = 'invalid' | 'not_found' | 'not_draft' | 'in_use';

export class ZoneEditError extends Error {
  constructor(
    message: string,
    readonly issues: PackIssue[] = [],
    readonly code: ZoneEditCode = 'invalid',
  ) {
    super(message);
    this.name = 'ZoneEditError';
  }
}

export async function listPackZones(sql: Sql, packId: string): Promise<ZoneView[]> {
  return withStaff(sql, async (tx) => {
    const [pack] = await tx`select manifest from product_packs where id = ${packId}`;
    if (!pack) throw new ZoneEditError('no such pack');

    const manifest = pack['manifest'] as PackManifest;
    const variantIds = await tx`
      select v.id, v.key as variant_key, pr.key as product_key
      from product_variants v join products pr on pr.id = v.product_id
      where pr.pack_id = ${packId}`;

    const idFor = new Map(
      variantIds.map((row) => [`${row['product_key']}/${row['variant_key']}`, row['id'] as string]),
    );

    const views: ZoneView[] = [];
    for (const product of manifest.products) {
      for (const variant of product.variants) {
        for (const zone of variant.zones) {
          views.push({
            productKey: product.key,
            productName: product.name,
            variantKey: variant.key,
            variantName: variant.name,
            variantId: idFor.get(`${product.key}/${variant.key}`) ?? '',
            zone,
            extentMm: zoneExtentMm(zone),
          });
        }
      }
    }
    return views;
  });
}

export async function updateZone(
  sql: Sql,
  address: ZoneAddress,
  patch: ZonePatch,
  actorId: string | null,
): Promise<ZoneView[]> {
  await withStaff(sql, async (tx) => {
    const [row] = await tx`
      select manifest, key, version, status from product_packs where id = ${address.packId}`;
    if (!row) throw new ZoneEditError('no such pack', [], 'not_found');

    const manifest = structuredClone(row['manifest']) as PackManifest;
    const product = manifest.products.find((candidate) => candidate.key === address.productKey);
    const variant = product?.variants.find((candidate) => candidate.key === address.variantKey);
    const index = variant?.zones.findIndex((candidate) => candidate.key === address.zoneKey) ?? -1;
    if (!variant || index < 0) throw new ZoneEditError('no such zone', [], 'not_found');

    if (
      patch.frame !== undefined ||
      patch.materialSlotKey !== undefined ||
      patch.mapping !== undefined
    ) {
      if (row['status'] !== 'draft') {
        throw new ZoneEditError(
          'a zone on a published pack cannot be moved or retargeted; make a new draft version first',
          [],
          'not_draft',
        );
      }
      const [ids] = await tx`
        select v.id from product_variants v join products pr on pr.id = v.product_id
        where pr.pack_id = ${address.packId} and pr.key = ${address.productKey} and v.key = ${address.variantKey}`;
      if (ids) await assertUnused(tx, ids['id'] as string, address.zoneKey, 'moved');
    }

    const zone = variant.zones[index]!;
    if (patch.name !== undefined) assertNameFree(variant.zones, patch.name, zone.key);
    applyPatch(zone, patch);
    if (patch.materialSlotKey === null) delete zone.materialSlotKey;
    else if (patch.materialSlotKey !== undefined) zone.materialSlotKey = patch.materialSlotKey;
    if (patch.mapping !== undefined) {
      if (
        !['planar', 'conformal'].includes(zone.type) ||
        !['planar', 'conformal'].includes(patch.mapping)
      )
        throw new ZoneEditError('Only flat and surface zones can change mapping.');
      if (patch.frame === undefined)
        throw new ZoneEditError('A mapping change needs its placement frame.');
      const { uvRect: _uvRect, ...mapped } = zone as Extract<DecorationZoneDef, { type: 'planar' }>;
      variant.zones[index] = parseZone({ ...mapped, type: patch.mapping, frame: patch.frame });
    } else if (patch.frame !== undefined) {
      variant.zones[index] = parseZone({ ...zone, frame: patch.frame });
    }
    const saved = variant.zones[index]!;

    assertStillValid(manifest, 'that change would make the pack invalid');

    await tx`update product_packs set manifest = ${tx.json(manifest as never)} where id = ${address.packId}`;

    // The derived row carries the same fields the importer writes, so a later re-import of the
    // edited manifest produces exactly what is stored now.
    await tx`
      update decoration_zones z
      set name = ${saved.name},
          type = ${saved.type},
          uv_rect = ${'uvRect' in saved && saved.uvRect ? tx.json(saved.uvRect as never) : null},
          frame = ${'frame' in saved ? tx.json(saved.frame as never) : null},
          size_mm = ${tx.json(saved.sizeMm as never)},
          constraints = ${tx.json(saved.constraints as never)}
      from product_variants v, products pr
      where z.variant_id = v.id and v.product_id = pr.id
        and pr.pack_id = ${address.packId} and pr.key = ${address.productKey}
        and v.key = ${address.variantKey} and z.key = ${address.zoneKey}`;

    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'zone.updated',
      targetType: 'decoration_zone',
      targetId: `${row['key']}@${row['version']}/${address.productKey}/${address.variantKey}/${address.zoneKey}`,
      metadata: { ...patch },
    });
  });

  return listPackZones(sql, address.packId);
}

/** Applies only the fields this zone type actually has; the rest are not silently dropped. */
function applyPatch(zone: DecorationZoneDef, patch: ZonePatch): void {
  if (patch.name !== undefined) zone.name = patch.name;

  if (patch.widthMm !== undefined) {
    if (zone.type === 'cylindrical') zone.sizeMm.arcWidthMm = patch.widthMm;
    else zone.sizeMm.width = patch.widthMm;
  }
  if (patch.heightMm !== undefined) zone.sizeMm.height = patch.heightMm;
  if (patch.safeMarginMm !== undefined) zone.sizeMm.safeMarginMm = patch.safeMarginMm;

  const constraints = zone.constraints;
  if (patch.finishes !== undefined) {
    if (patch.finishes.length === 0) throw new ZoneEditError('a zone needs at least one finish');
    constraints.finishes = patch.finishes;
  }
  if (patch.maxDepthMm !== undefined) constraints.maxDepthMm = patch.maxDepthMm;
  if (patch.minStrokeMm !== undefined) constraints.minStrokeMm = patch.minStrokeMm;
  if (patch.maxCoverage !== undefined) constraints.maxCoverage = patch.maxCoverage;
  if (patch.wrapWarnDeg !== undefined) constraints.wrapWarnDeg = patch.wrapWarnDeg;
}

export interface VariantAddress {
  packId: string;
  productKey: string;
  variantKey: string;
}

/**
 * The zone types a person can add from the Zones page (F-ADM-13).
 *
 * The three that address the part in millimetres. `uv_rect` needs authored UVs, which an uploaded
 * part never has, and `flat_panel` is a carton dieline; both still arrive through a manifest.
 */
export const AUTHORABLE_ZONE_TYPES = ['planar', 'cylindrical', 'conformal'] as const;

/**
 * A key for a new zone, from the name a person gave it.
 *
 * Keys are what a design stores, so they never change once made. Taking one from the name means
 * nobody has to invent an identifier, and the suffix keeps two zones called "Logo" apart.
 */
export function zoneKeyFrom(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'zone';
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    if (!used.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
}

/** Adds a zone to a draft pack's variant and returns the key it was given. */
export async function addZone(
  sql: Sql,
  address: VariantAddress,
  input: Record<string, unknown>,
  actorId: string | null,
): Promise<string> {
  return withStaff(sql, async (tx) => {
    const { row, manifest, variant, variantId } = await loadDraftVariant(tx, address, 'added to');

    if (!AUTHORABLE_ZONE_TYPES.includes(input['type'] as (typeof AUTHORABLE_ZONE_TYPES)[number])) {
      throw new ZoneEditError(`a zone added here is one of: ${AUTHORABLE_ZONE_TYPES.join(', ')}`);
    }
    const name = typeof input['name'] === 'string' ? input['name'].trim().slice(0, 120) : '';
    if (!name) throw new ZoneEditError('a zone needs a name');

    assertNameFree(variant.zones, name);
    const key = zoneKeyFrom(
      name,
      variant.zones.map((zone) => zone.key),
    );
    const zone = parseZone({ ...input, name, key });
    variant.zones.push(zone);
    assertStillValid(manifest, 'that zone would make the pack invalid');

    await tx`update product_packs set manifest = ${tx.json(manifest as never)} where id = ${address.packId}`;
    await tx`
      insert into decoration_zones (id, variant_id, key, name, type, frame, size_mm, uv_rect,
                                    constraints, sort)
      values (${uuidv7()}, ${variantId}, ${zone.key}, ${zone.name}, ${zone.type},
              ${'frame' in zone ? tx.json(zone.frame as never) : null},
              ${tx.json(zone.sizeMm as never)}, null,
              ${tx.json(zone.constraints as never)}, ${variant.zones.length - 1})`;

    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'zone.added',
      targetType: 'decoration_zone',
      targetId: `${row['key']}@${row['version']}/${address.productKey}/${address.variantKey}/${zone.key}`,
      metadata: { type: zone.type, name: zone.name },
    });

    return zone.key;
  });
}

/**
 * Removes a zone from a draft pack.
 *
 * Refused while a design still places artwork in it, for the same reason a re-import refuses to
 * orphan one: the design would open with a logo that has nowhere to go.
 */
export async function removeZone(
  sql: Sql,
  address: ZoneAddress,
  actorId: string | null,
): Promise<void> {
  await withStaff(sql, async (tx) => {
    const { row, manifest, variant, variantId } = await loadDraftVariant(
      tx,
      address,
      'removed from',
    );

    const index = variant.zones.findIndex((zone) => zone.key === address.zoneKey);
    if (index < 0) throw new ZoneEditError('no such zone', [], 'not_found');

    await assertUnused(tx, variantId, address.zoneKey, 'removed');

    variant.zones.splice(index, 1);
    await tx`update product_packs set manifest = ${tx.json(manifest as never)} where id = ${address.packId}`;
    await tx`delete from decoration_zones where variant_id = ${variantId} and key = ${address.zoneKey}`;

    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'zone.removed',
      targetType: 'decoration_zone',
      targetId: `${row['key']}@${row['version']}/${address.productKey}/${address.variantKey}/${address.zoneKey}`,
      metadata: {},
    });
  });
}

/** One variant as the Zones page shows it, with or without zones. */
export interface AuthoringVariant {
  productKey: string;
  productName: string;
  variantKey: string;
  variantName: string;
  variantId: string;
  /** As measured when the pack was made; shown as a reference, never used to place anything. */
  bboxMm: [Vec3, Vec3];
  /** The mesh the preview draws, or null when the pack has none stored. */
  meshKey: string | null;
  meshDigest?: string;
  zones: DecorationZoneDef[];
  presentationOrientation?: PresentationOrientation;
  materialSlots: ProductVariantDef['materialSlots'];
}

export interface PackAuthoring {
  revision: string;
  id: string;
  key: string;
  version: string;
  name: string;
  status: 'draft' | 'published' | 'deprecated';
  /** A draft version of the same pack already in progress, which is where changes belong. */
  openDraft: { id: string; version: string } | null;
  variants: AuthoringVariant[];
}

/**
 * Everything the Zones page needs, variant by variant.
 *
 * Listed from the manifest's variants rather than from their zones: a pack made from an upload has
 * none yet, and a page that listed variants by their zones had nothing to show it.
 */
export async function getPackAuthoring(sql: Sql, packId: string): Promise<PackAuthoring> {
  return withStaff(sql, async (tx) => {
    const [pack] =
      await tx`select id, key, version, name, status, manifest from product_packs where id = ${packId}`;
    if (!pack) throw new ZoneEditError('no such pack', [], 'not_found');

    const [openDraft] = await tx`
      select id, version from product_packs
      where key = ${pack['key']} and status = 'draft' and id <> ${packId}
      order by created_at desc limit 1`;

    const rows = await tx`
      select v.id, v.key as variant_key, pr.key as product_key,
             (select a.storage_key from product_assets a
               where a.variant_id = v.id and a.kind = 'lod0' limit 1) as mesh_key
      from product_variants v join products pr on pr.id = v.product_id
      where pr.pack_id = ${packId}`;
    const byKey = new Map(rows.map((row) => [`${row['product_key']}/${row['variant_key']}`, row]));

    const manifest = pack['manifest'] as PackManifest;
    return {
      revision: setupRevision(pack['manifest']),
      id: pack['id'] as string,
      key: pack['key'] as string,
      version: pack['version'] as string,
      name: pack['name'] as string,
      status: pack['status'] as PackAuthoring['status'],
      openDraft: openDraft
        ? { id: openDraft['id'] as string, version: openDraft['version'] as string }
        : null,
      variants: manifest.products.flatMap((product) =>
        product.variants.map((variant) => {
          const row = byKey.get(`${product.key}/${variant.key}`);
          return {
            productKey: product.key,
            productName: product.name,
            variantKey: variant.key,
            variantName: variant.name,
            variantId: (row?.['id'] as string | undefined) ?? '',
            bboxMm: variant.dimensionsMm.bbox,
            meshDigest: variant.assets.lod0.digest,
            meshKey: (row?.['mesh_key'] as string | null | undefined) ?? null,
            zones: variant.zones,
            presentationOrientation: variant.presentationOrientation,
            materialSlots: variant.materialSlots,
          };
        }),
      ),
    };
  });
}

async function loadDraftVariant(tx: Tx, address: VariantAddress, verb: string) {
  const [row] =
    await tx`select manifest, key, version, status from product_packs where id = ${address.packId}`;
  if (!row) throw new ZoneEditError('no such pack', [], 'not_found');
  if (row['status'] !== 'draft') {
    throw new ZoneEditError(
      `zones can only be ${verb} a draft pack; make a new draft version and change it there`,
      [],
      'not_draft',
    );
  }

  const manifest = structuredClone(row['manifest']) as PackManifest;
  const product = manifest.products.find((candidate) => candidate.key === address.productKey);
  const variant = product?.variants.find((candidate) => candidate.key === address.variantKey);
  if (!variant) throw new ZoneEditError('no such variant', [], 'not_found');

  const [ids] = await tx`
    select v.id from product_variants v join products pr on pr.id = v.product_id
    where pr.pack_id = ${address.packId} and pr.key = ${address.productKey} and v.key = ${address.variantKey}`;
  if (!ids) throw new ZoneEditError('no such variant', [], 'not_found');

  return { row, manifest, variant, variantId: ids['id'] as string };
}

/**
 * Refuses to move or remove a zone that a design places artwork in.
 *
 * Draft-only is not enough on its own: a pack can be set back to draft after customers have made
 * designs on it, and moving the zone underneath them moves their logos just the same. The refusal
 * names the designs, so whoever is editing knows what is in the way.
 */
async function assertUnused(
  tx: Tx,
  variantId: string,
  zoneKey: string,
  verb: string,
): Promise<void> {
  const users = await tx`
    select d.name
    from designs d
    join design_versions dv on dv.id = d.current_version_id
    where d.product_variant_id = ${variantId}
      and d.deleted_at is null
      and dv.document -> 'placements' @> ${tx.json([{ zoneKey }] as never)}
    order by d.updated_at desc`;
  if (users.length === 0) return;

  const names = users
    .slice(0, 3)
    .map((design) => `"${design['name'] as string}"`)
    .join(', ');
  const count = users.length === 1 ? '1 design places' : `${users.length} designs place`;
  throw new ZoneEditError(
    `this zone cannot be ${verb}: ${count} artwork in it (${names}${users.length > 3 ? ', …' : ''}). ` +
      `${verb === 'moved' ? 'Moving' : 'Removing'} it would take their logo with it — delete ` +
      `${users.length === 1 ? 'that design' : 'those designs'} first, or add a new zone instead.`,
    [],
    'in_use',
  );
}

/**
 * Refuses a name another zone on the variant already has.
 *
 * The name is what a customer picks a zone by in the editor, and two zones called "Lid logo" cannot
 * be told apart there. Compared without case or surrounding space, because "Lid logo" and "lid LOGO "
 * read as the same thing to the person choosing.
 */
function assertNameFree(
  zones: readonly DecorationZoneDef[],
  name: string,
  exceptKey?: string,
): void {
  const wanted = name.trim().toLowerCase();
  const taken = zones.find(
    (zone) => zone.key !== exceptKey && zone.name.trim().toLowerCase() === wanted,
  );
  if (taken)
    throw new ZoneEditError(`another zone on this variant is already called "${taken.name}"`);
}

/** A zone as the schema defines it, or a refusal that says which field is wrong. */
function parseZone(raw: unknown): DecorationZoneDef {
  const parsed = DecorationZoneDef.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ZoneEditError(
    'that zone is not complete',
    parsed.error.issues.map((issue) => ({
      severity: 'error' as const,
      code: 'schema_invalid' as const,
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

/**
 * The manifest has to still be a manifest. Validating the whole thing rather than the one zone
 * catches the edits that are only wrong in context — artwork wider than the circumference it
 * wraps, a safe margin that leaves no printable area.
 */
function assertStillValid(manifest: PackManifest, message: string): void {
  const validation = validatePack(manifest);
  if (!validation.publishable) {
    throw new ZoneEditError(
      message,
      validation.issues.filter((issue) => issue.severity === 'error'),
    );
  }
}
