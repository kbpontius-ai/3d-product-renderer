import { redirect } from 'next/navigation';
import { listDeletedDesigns, listDesigns, RESTORE_WINDOW_DAYS } from '@pr/designs';
import { DesignBrowser } from '@/components/design-browser';
import { RestoreDesign } from '@/components/restore-design';
import { assetUrl } from '@/lib/server/storage';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured, getSql } from '@/lib/server/db';
import { NotConfigured } from '../../(auth)/not-configured';

/** Everything this organisation has saved, most recently touched first (W-03). */
export const dynamic = 'force-dynamic';

export default async function DesignsPage() {
  if (!databaseConfigured()) return <NotConfigured />;

  const principal = await getPrincipal();
  if (!principal) redirect('/signin?next=/designs');

  const ctx = { orgId: principal.orgId, userId: principal.userId };
  const sql = getSql();
  const [designs, deleted] = await Promise.all([
    listDesigns(sql, ctx),
    listDeletedDesigns(sql, ctx),
  ]);

  const thumbnailRevision = Date.now();

  return (
    <main className="catalog" data-testid="designs">
      <header className="catalog-head">
        <div>
          <h1>Designs</h1>
          <p className="auth-sub">
            Your team’s projects.
          </p>
        </div>
        <div className="head-actions">
          <a href="/catalog" className="primary" data-testid="new-design">+ New design</a>
        </div>
      </header>

      {designs.length === 0 ? (
        <p className="auth-sub" data-testid="designs-empty">
          Nothing saved yet. Pick a product from the catalog to start one.
        </p>
      ) : (
        <DesignBrowser designs={designs.map(({ thumbnailKey, ...design }) => ({
          ...design,
          // A fresh URL also bypasses thumbnails cached before mutable-image caching was fixed.
          thumbnailUrl: thumbnailKey ? `${assetUrl(thumbnailKey, ctx.userId ?? ctx.orgId)}&v=${thumbnailRevision}` : null,
        }))} />
      )}
      {deleted.length > 0 && (
        <>
          <h2 className="deleted-head">Recently deleted</h2>
          <p className="auth-sub">
            Deleted designs can be restored for {RESTORE_WINDOW_DAYS} days.
          </p>
          <ul className="design-list" data-testid="deleted-designs">
            {deleted.map((design) => (
              <li key={design.id} data-testid={`deleted-${design.id}`}>
                <span>
                  <strong>{design.name}</strong>
                  <span>
                    {design.productName} · {design.variantName}
                  </span>
                  <small>deleted {new Date(design.updatedAt).toLocaleString()}</small>
                </span>
                <span className="design-actions">
                  <RestoreDesign designId={design.id} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
