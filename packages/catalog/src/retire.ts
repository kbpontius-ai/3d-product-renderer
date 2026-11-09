import { recordAudit, type Tx } from '@pr/db';

/**
 * Retires every other published version of a pack, now that `packId` is the published one.
 *
 * One version of a pack is offered at a time. Two published versions used to merge in the catalog
 * into one product listing every size twice, one of them the version somebody had just fixed. The
 * retired versions become `deprecated`: nobody starts a new design on them, and every design already
 * made on one keeps opening, saving and rendering against the version it was built on.
 *
 * Runs inside the caller's transaction, so a publish and the retirement it implies land together.
 */
export async function retireOtherVersions(
  tx: Tx,
  packId: string,
  actorId: string | null,
): Promise<string[]> {
  const retired = await tx`
    update product_packs old
    set status = 'deprecated', published_at = null
    from product_packs current
    where current.id = ${packId}
      and old.key = current.key
      and old.id <> current.id
      and old.status = 'published'
    returning old.id, old.version, current.version as replaced_by`;

  for (const row of retired) {
    await tx`update products set status = 'deprecated' where pack_id = ${row['id']}`;
    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'pack.deprecated',
      targetType: 'product_pack',
      targetId: row['id'] as string,
      metadata: { version: row['version'], supersededBy: row['replaced_by'] },
    });
  }

  return retired.map((row) => row['version'] as string);
}
