import { listMembers, listOrgPacks } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { actorFor, requireOwner } from '@/lib/server/org';

/**
 * The organisation's products, read the other way round: who cannot use each (F-ORG-03).
 *
 * The same facts as the member page, arranged for the other question an owner asks — not "what may
 * Alice use" but "who is on the bottle line". Changing access happens on the person, because that
 * is where the consequence lands.
 */
export const dynamic = 'force-dynamic';

export default async function OrgCatalogPage() {
  const principal = await requireOwner();
  const actor = actorFor(principal);
  const [packs, members] = await Promise.all([
    listOrgPacks(getSql(), actor),
    listMembers(getSql(), actor),
  ]);

  const withheldFrom = (packId: string) =>
    members.filter((m) => m.withheldPackIds.includes(packId));

  return (
    <section>
      <header className="admin-head">
        <div>
          <h1>Products</h1>
          <p className="auth-sub">
            {packs.length} published to this organization. Product access can be managed for each member.
          </p>
        </div>
      </header>

      <div className="table-wrap">
        <table className="admin-table" data-testid="org-catalog-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Version</th>
              <th>Restricted for</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => {
              const blocked = withheldFrom(pack.id);
              return (
                <tr key={pack.id} data-testid={`org-pack-${pack.key}`}>
                  <td>{pack.name}</td>
                  <td className="mono">{pack.version}</td>
                  <td data-testid={`org-pack-withheld-${pack.key}`}>
                    {blocked.length === 0 ? (
                      'No restrictions'
                    ) : (
                      <ul className="inline-list">
                        {blocked.map((m) => (
                          <li key={m.id}>
                            <a href={`/org/people/${m.id}`}>{m.email}</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {packs.length === 0 && (
        <p className="readout">
          Nothing published to this organization yet. Products arrive as Product Packs, which support
          publishes.
        </p>
      )}
    </section>
  );
}
