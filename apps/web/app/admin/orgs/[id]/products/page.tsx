import Link from 'next/link';
import { listMembers, listOrgPacks } from '@pr/admin';
import { requireStaff } from '@/lib/server/admin';
import { getAdminOrganization } from '@/lib/server/admin-org';
import { getSql } from '@/lib/server/db';

export default async function OrganizationProducts({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const principal = await requireStaff();
  const { id } = await params;
  await getAdminOrganization(id);
  const actor = { userId: principal.userId, orgId: id, role: principal.role };
  const [packs, members] = await Promise.all([
    listOrgPacks(getSql(), actor),
    listMembers(getSql(), actor),
  ]);
  return (
    <div data-testid="org-products">
      <h2>Products</h2>
      <p className="auth-sub">
        Published product packs available to this organization. Owners and staff see the whole
        organization catalog.
      </p>
      <div className="org-product-grid">
        {packs.map((pack) => {
          const restricted = members.filter(
            (member) => member.role === 'member' && member.withheldPackIds.includes(pack.id),
          );
          return (
            <section className="org-panel" key={pack.id}>
              <h3>{pack.name}</h3>
              <p className="auth-sub">
                {pack.key} · Version {pack.version}
              </p>
              <p>
                {restricted.length === 0
                  ? 'No member restrictions'
                  : `${restricted.length} member${restricted.length === 1 ? '' : 's'} restricted`}
              </p>
              {restricted.length > 0 && (
                <ul>
                  {restricted.map((member) => (
                    <li key={member.id}>
                      <Link href={`/admin/orgs/${id}/people/${member.id}`}>{member.email}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {packs.length === 0 && (
        <p className="readout">This organization has no published products yet.</p>
      )}
      <p className="auth-sub">
        Publishing and organization visibility are managed in <Link href="/admin/packs">Packs</Link>
        . Owners manage member restrictions in their Organization area.
      </p>
    </div>
  );
}
