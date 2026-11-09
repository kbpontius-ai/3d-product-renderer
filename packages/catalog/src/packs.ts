import { OrientationEditError } from './orientation.js';
import { PackManifest } from '@pr/design-schema';
import { recordAudit, withStaff, type Sql } from '@pr/db';
import { retireOtherVersions } from './retire.js';

/**
 * Managing packs after they are imported (F-ADM-03).
 *
 * Import puts a pack in the catalog; this decides who can see it and whether it is still offered.
 * Deprecating is deliberately not deleting: designs pin the variant they were made against, and a
 * pack that vanished would take working designs with it.
 */

export type PackStatus = 'draft' | 'published' | 'deprecated';

export interface PackSummary {
  id: string;
  key: string;
  version: string;
  name: string;
  status: PackStatus;
  products: number;
  variants: number;
  zones: number;
  /** Designs currently pointing at a variant from this pack — what deprecating would affect. */
  designs: number;
  /** Empty means visible to every organisation. */
  visibleToOrgIds: string[];
  createdAt: string;
  publishedAt: string | null;
}

export async function listPacks(sql: Sql): Promise<PackSummary[]> {
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select
        p.id, p.key, p.version, p.name, p.status, p.created_at, p.published_at,
        (select count(*) from products pr where pr.pack_id = p.id) as products,
        (select count(*) from product_variants v
           join products pr on pr.id = v.product_id where pr.pack_id = p.id) as variants,
        (select count(*) from decoration_zones z
           join product_variants v on v.id = z.variant_id
           join products pr on pr.id = v.product_id where pr.pack_id = p.id) as zones,
        (select count(*) from designs d
           join product_variants v on v.id = d.product_variant_id
           join products pr on pr.id = v.product_id
          where pr.pack_id = p.id and d.deleted_at is null) as designs,
        coalesce(
          (select array_agg(pv.org_id::text) from pack_visibility pv where pv.pack_id = p.id),
          '{}'
        ) as visible_to
      from product_packs p
      order by p.key, p.created_at desc`;

    return rows.map((row) => ({
      id: row['id'] as string,
      key: row['key'] as string,
      version: row['version'] as string,
      name: row['name'] as string,
      status: row['status'] as PackStatus,
      products: Number(row['products']),
      variants: Number(row['variants']),
      zones: Number(row['zones']),
      designs: Number(row['designs']),
      visibleToOrgIds: (row['visible_to'] as string[]) ?? [],
      createdAt: (row['created_at'] as Date).toISOString(),
      publishedAt: row['published_at'] ? (row['published_at'] as Date).toISOString() : null,
    }));
  });
}

export async function getPack(sql: Sql, packId: string): Promise<PackSummary> {
  const pack = (await listPacks(sql)).find((candidate) => candidate.id === packId);
  if (!pack) throw new Error('no such pack');
  return pack;
}

/**
 * Moves a pack between draft, published and deprecated.
 *
 * The products move with it: a published pack whose products stayed in draft would be a catalog
 * entry nobody could open, and the two states drifting apart is exactly the bug that produces one.
 * Publishing a version retires the pack's other published version (`retireOtherVersions`).
 */
export async function setPackStatus(
  sql: Sql,
  packId: string,
  status: PackStatus,
  actorId: string | null,
): Promise<PackSummary> {
  await withStaff(sql, async (tx) => {
    const [pack] =
      await tx`select id, key, version, status, manifest from product_packs where id = ${packId} for update`;
    if (!pack) throw new Error('no such pack');

    if (
      status === 'published' &&
      PackManifest.parse(pack['manifest']).products.some((p) =>
        p.variants.some((v) => v.presentationOrientation && !v.presentationOrientation.confirmed),
      )
    ) {
      throw new OrientationEditError(
        'Confirm orientation for every new variant before publishing.',
        'invalid',
      );
    }

    await tx`
      update product_packs
      set status = ${status}, published_at = ${status === 'published' ? new Date() : null}
      where id = ${packId}`;
    await tx`update products set status = ${status} where pack_id = ${packId}`;
    if (status === 'published') await retireOtherVersions(tx, packId, actorId);

    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: `pack.${status}`,
      targetType: 'product_pack',
      targetId: packId,
      metadata: { key: pack['key'], version: pack['version'], from: pack['status'] },
    });
  });

  return getPack(sql, packId);
}

/** Restricts a pack to named organisations, or (with an empty list) offers it to everyone. */
export async function setPackVisibility(
  sql: Sql,
  packId: string,
  orgIds: string[],
  actorId: string | null,
): Promise<PackSummary> {
  await withStaff(sql, async (tx) => {
    await tx`delete from pack_visibility where pack_id = ${packId}`;
    for (const orgId of orgIds) {
      await tx`insert into pack_visibility (pack_id, org_id) values (${packId}, ${orgId})`;
    }

    await recordAudit(tx, {
      orgId: orgIds.length === 1 ? orgIds[0]! : null,
      actorUserId: actorId,
      action: 'pack.visibility_changed',
      targetType: 'product_pack',
      targetId: packId,
      metadata: { orgs: orgIds.length || 'everyone' },
    });
  });

  return getPack(sql, packId);
}

export interface DraftedPack {
  id: string;
  key: string;
  version: string;
  status: PackStatus;
}

/**
 * The packs whose first mesh is one of these, by digest (F-ADM-13).
 *
 * How a finished CAD ingestion knows which packs were drafted from it without anyone having recorded
 * the link: drafting carries the mesh digests into the pack's assets, so the same digest on both
 * sides *is* the link. A new draft version copies the meshes, so every version of a drafted pack
 * turns up here too.
 */
export async function packsByMeshDigest(
  sql: Sql,
  digests: readonly string[],
): Promise<Record<string, DraftedPack[]>> {
  const wanted = digests.filter((digest) => /^[0-9a-f]{64}$/.test(digest));
  if (wanted.length === 0) return {};

  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select distinct encode(a.digest, 'hex') as digest, p.id, p.key, p.version, p.status, p.created_at
      from product_assets a
      join product_variants v on v.id = a.variant_id
      join products pr on pr.id = v.product_id
      join product_packs p on p.id = pr.pack_id
      where a.kind = 'lod0' and encode(a.digest, 'hex') in ${tx(wanted as string[])}
      order by p.created_at`;

    const found: Record<string, DraftedPack[]> = {};
    for (const row of rows) {
      (found[row['digest'] as string] ??= []).push({
        id: row['id'] as string,
        key: row['key'] as string,
        version: row['version'] as string,
        status: row['status'] as PackStatus,
      });
    }
    return found;
  });
}

/** Whether this key and version is already in the catalog, and in what state. */
export async function packVersionStatus(
  sql: Sql,
  key: string,
  version: string,
): Promise<PackStatus | null> {
  return withStaff(sql, async (tx) => {
    const [row] =
      await tx`select status from product_packs where key = ${key} and version = ${version}`;
    return (row?.['status'] as PackStatus | undefined) ?? null;
  });
}
