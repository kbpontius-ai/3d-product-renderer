import { listOrganizations } from '@pr/admin';
import { listPacks } from '@pr/catalog';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { PackUpload } from './pack-upload';
import { PackRow } from './pack-row';

/**
 * Packs (F-ADM-01, F-ADM-03).
 *
 * A pack is the only way a product enters the catalog, so this page is the whole content pipeline:
 * upload, look at what it would do, import, publish, restrict, retire.
 */
export const dynamic = 'force-dynamic';

export default async function AdminPacksPage() {
  await requireStaff();
  const sql = getSql();
  const [packs, orgs] = await Promise.all([listPacks(sql), listOrganizations(sql)]);

  return (
    <section data-testid="packs">
      <header className="admin-head">
        <div>
          <h1>Product packs</h1>
          <p className="auth-sub">
            {packs.length} pack{packs.length === 1 ? '' : 's'} ·{' '}
            {packs.filter((p) => p.status === 'published').length} published.
          </p>
        </div>
      </header>

      <PackUpload />

      <h2>Installed</h2>
      <div className="table-wrap">
        <table className="admin-table" data-testid="pack-table">
          <thead>
            <tr>
              <th>Pack</th>
              <th>Contents</th>
              <th>In use</th>
              <th>Visible to</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <PackRow
                key={pack.id}
                pack={pack}
                orgs={orgs.map((o) => ({ id: o.id, name: o.name }))}
                replaces={
                  packs.find((other) => other.key === pack.key && other.id !== pack.id && other.status === 'published')
                    ?.version
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      {packs.length === 0 && (
        <p className="auth-sub" data-testid="packs-empty">
          Nothing installed. Upload a pack to put a product in the catalog.
        </p>
      )}
    </section>
  );
}
