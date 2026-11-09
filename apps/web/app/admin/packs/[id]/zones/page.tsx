import { getPackAuthoring } from '@pr/catalog';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { NewVersionButton } from './new-version-button';
import { VariantZones } from './variant-zones';

/**
 * Zone authoring for one pack (F-ADM-02, F-ADM-13, F-ADM-14).
 *
 * Grouped by variant, because that is how a person thinks about it: this cap, its top and its
 * skirt. Every variant is listed whether or not it has zones yet — a pack made from an upload has
 * none, and this is where they are added. Each zone is drawn on the part as it is edited, and can be
 * checked with a test pattern once the pack is published.
 */
export const dynamic = 'force-dynamic';

export default async function ZonesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;

  const pack = await getPackAuthoring(getSql(), id);
  const zoneCount = pack.variants.reduce((n, variant) => n + variant.zones.length, 0);
  const draft = pack.status === 'draft';

  return (
    <section data-testid="zones">
      <header className="admin-head">
        <div>
          <h1>Zones — {pack.name}</h1>
          <p className="auth-sub">
            {pack.key}@{pack.version} ·{' '}
            <span className={draft ? 'pill warn' : 'pill ok'}>{pack.status}</span> · {zoneCount}{' '}
            zone{zoneCount === 1 ? '' : 's'} across {pack.variants.length} variant
            {pack.variants.length === 1 ? '' : 's'}.
          </p>
        </div>
        <a className="auth-link" href="/admin/packs">
          All packs
        </a>
      </header>

      {!draft && (
        <div className="zone-banner" data-testid="zones-published">
          <p>
            This version is {pack.status}, so its zones cannot be added, moved or removed —
            customers&rsquo; designs are built on them. Size, margin and finishes can still be
            adjusted. To change placement, make a new draft version; this one and every design on it
            stay exactly as they are.
          </p>
          {pack.openDraft ? (
            <p>
              <a className="auth-link" href={`/admin/packs/${pack.openDraft.id}/zones`} data-testid="open-draft-version">
                {pack.key}@{pack.openDraft.version} is already a draft — open it
              </a>
            </p>
          ) : (
            <NewVersionButton packId={pack.id} />
          )}
        </div>
      )}

      {pack.variants.map((variant) => (
        <VariantZones
          key={`${variant.productKey}/${variant.variantKey}`}
          packId={pack.id}
          variant={variant}
          draft={draft}
          published={pack.status === 'published'}
        />
      ))}
    </section>
  );
}
