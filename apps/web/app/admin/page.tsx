import Link from 'next/link';
import { countUsers, listOrganizations, listUsers } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { currentPage, listQuery, PAGE_SIZE } from '@/lib/admin-list';
import { AdminPagination } from '@/components/admin-pagination';
import { NewOrgForm } from './new-org-form';
import { OrganizationTable } from './organization-table';
import { UserSearch } from './users/user-search';

export const dynamic = 'force-dynamic';

export default async function AdminOrgsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStaff();
  const { q, page: requested } = listQuery.parse(await searchParams);
  const sql = getSql();
  const [orgs, total] = await Promise.all([
    listOrganizations(sql),
    q ? countUsers(sql, { query: q }) : Promise.resolve(0),
  ]);
  const page = currentPage(requested, total);
  const users = q
    ? await listUsers(sql, { query: q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
    : [];
  return (
    <section>
      <header className="admin-head">
        <div>
          <h1>Organizations</h1>
          <p className="auth-sub">Manage accounts, access and usage limits.</p>
        </div>
        <NewOrgForm />
      </header>
      <section className="org-email-lookup">
        <UserSearch key={q} initial={q} />
        {q && (
          <>
            <header className="org-lookup-head">
              <p className="auth-sub">
                {total} accounts matching “{q}”. Open a result in its organization to manage access.
              </p>
              <Link href="/admin">Clear</Link>
            </header>
            {users.length > 0 && (
              <div className="table-wrap">
                <table className="admin-table" data-testid="user-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Organization</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>{user.email}</td>
                        <td>{user.orgName}</td>
                        <td>{user.role}</td>
                        <td>{user.status}</td>
                        <td>
                          <Link href={`/admin/orgs/${user.orgId}/people/${user.id}`}>
                            Open person →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {total === 0 && <p className="readout">No accounts match this email search.</p>}
            <AdminPagination path="/admin" page={page} total={total} filters={{ q }} />
          </>
        )}
      </section>
      <OrganizationTable organizations={orgs} />
    </section>
  );
}
