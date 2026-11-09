import { withTenant, type Sql, type Tx, type TenantContext } from '@pr/db';
import type { DesignDocument } from '@pr/design-schema';

export interface ArchivedArtwork {
  artworkId: string;
  name: string;
}

export class ArtworkError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'too_large'
      | 'invalid'
      | 'in_use'
      | 'version_conflict'
      | 'archived_artwork',
    message?: string,
    readonly archivedArtworks?: ArchivedArtwork[],
  ) {
    super(message ?? code);
    this.name = 'ArtworkError';
  }
}

export async function lockArtworkUsage(tx: Tx, orgId: string): Promise<void> {
  // A shared tenant lock prevents an archive from racing a save that removes its last reference.
  // Acquire it before any artwork/design row lock to keep the ordering identical across writers.
  await tx`select pg_advisory_xact_lock(hashtextextended(${orgId}, 176865))`;
}

export async function archivedArtworkReferences(
  tx: Tx,
  document: Pick<DesignDocument, 'placements'>,
): Promise<ArchivedArtwork[]> {
  const ids = (document.placements ?? []).map((placement) => placement.artwork.versionId);
  if (ids.length === 0) return [];
  const rows = await tx`select distinct a.id, a.name from artworks a
    join artwork_versions v on v.artwork_id = a.id
    where v.id in ${tx(ids)} and a.archived_at is not null
    order by a.name, a.id`;
  return rows.map((row) => ({ artworkId: row['id'] as string, name: row['name'] as string }));
}

export async function assertActiveArtworkReferences(
  tx: Tx,
  document: Pick<DesignDocument, 'placements'>,
): Promise<void> {
  const archived = await archivedArtworkReferences(tx, document);
  if (archived.length)
    throw new ArtworkError(
      'archived_artwork',
      'Restore archived artwork before editing or rendering this design.',
      archived,
    );
}

export async function assertDesignArtworkActive(tx: Tx, designId: string): Promise<void> {
  const [row] = await tx`select dv.document from designs d
    join design_versions dv on dv.id = d.current_version_id
    where d.id = ${designId} and d.deleted_at is null`;
  if (!row) return;
  await assertActiveArtworkReferences(tx, row['document'] as DesignDocument);
}

export async function assertArtworkActive(tx: Tx, artworkId: string): Promise<void> {
  const [row] = await tx`select id, name, archived_at from artworks
    where id = ${artworkId} and deleted_at is null`;
  if (!row) throw new ArtworkError('not_found');
  if (row['archived_at'])
    throw new ArtworkError('archived_artwork', 'Restore this artwork before editing it.', [
      { artworkId, name: row['name'] as string },
    ]);
}

async function usageCount(tx: Tx, artworkId: string): Promise<number> {
  const [row] = await tx`select count(*)::int as count from designs d
    join design_versions dv on dv.id = d.current_version_id
    where d.deleted_at is null and exists (
      select 1 from jsonb_array_elements(dv.document -> 'placements') p
      join artwork_versions v on v.id = (p -> 'artwork' ->> 'versionId')::uuid
      where v.artwork_id = ${artworkId})`;
  return Number(row?.['count'] ?? 0);
}

export async function artworkArchiveUsage(sql: Sql, ctx: TenantContext, artworkId: string) {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await tx`select id from artworks where id = ${artworkId} and deleted_at is null`;
    if (!row) throw new ArtworkError('not_found');
    return { usageCount: await usageCount(tx, artworkId) };
  });
}

export async function setArtworkArchived(
  sql: Sql,
  ctx: TenantContext,
  artworkId: string,
  archived: boolean,
) {
  return withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    const [row] = await tx`update artworks
      set archived_at = case when ${archived} then coalesce(archived_at, now()) else null end
      where id = ${artworkId} and deleted_at is null returning archived_at`;
    if (!row) throw new ArtworkError('not_found');
    return {
      archivedAt: row['archived_at'] ? (row['archived_at'] as Date).toISOString() : null,
      usageCount: await usageCount(tx, artworkId),
    };
  });
}
