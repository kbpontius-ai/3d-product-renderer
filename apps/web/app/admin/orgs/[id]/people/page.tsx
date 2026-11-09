import Link from 'next/link';
import { countUsers, listUsers } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { getAdminOrganization } from '@/lib/server/admin-org';
import { currentPage, listQuery, PAGE_SIZE } from '@/lib/admin-list';
import { AdminPagination } from '@/components/admin-pagination';
import { InvitePerson } from './invite-person';

export default async function OrganizationPeople({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requireStaff();
  const { id } = await params;
  const org = await getAdminOrganization(id);
  const search = await searchParams;
  const { q, role, status, page: requested } = listQuery.parse(search);
  const filters = { orgId: id, query: q, ...(role ? { role } : {}), ...(status ? { status } : {}) };
  const total = await countUsers(getSql(), filters);
  const page = currentPage(requested, total);
  const users = await listUsers(getSql(), {
    ...filters,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const path = `/admin/orgs/${id}/people`;
  return (
    <div data-testid="org-people">
      <header className="admin-head org-section-head">
        <div>
          <h2>People</h2>
          <p className="auth-sub">
            {org.users} accounts in {org.name}. Open a person to manage their access.
          </p>
        </div>
        <InvitePerson
          orgId={id}
          orgName={org.name}
          firstOwner={org.users === 0 || search['invite'] === 'owner'}
        />
      </header>
      <form className="library-toolbar" action={path} key={`${q}-${role}-${status}`}>
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by email…"
          aria-label="Search organization people"
          data-testid="people-search"
        />
        <select
          name="status"
          defaultValue={status ?? ''}
          aria-label="Account status"
          data-testid="people-status"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="suspended">Suspended</option>
        </select>
        <select
          name="role"
          defaultValue={role ?? ''}
          aria-label="Account role"
          data-testid="people-role"
        >
          <option value="">All roles</option>
          <option value="member">Member</option>
          <option value="owner">Owner</option>
          <option value="staff">Staff</option>
        </select>
        <button type="submit">Apply</button>
        {(q || role || status) && <Link href={path}>Clear</Link>}
      </form>
      <div className="table-wrap">
        <table className="admin-table" data-testid="org-users">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Sessions</th>
              <th>Last signed in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} data-testid={`user-${user.email}`}>
                <td>
                  <Link href={`${path}/${user.id}`}>
                    <strong>{user.email}</strong>
                  </Link>
                  {user.id === principal.userId && <span className="chip"> you</span>}
                </td>
                <td>{user.role}</td>
                <td>
                  <span
                    className={
                      user.status === 'active'
                        ? 'pill ok'
                        : user.status === 'suspended'
                          ? 'pill warn'
                          : 'pill'
                    }
                  >
                    {user.status}
                  </span>
                </td>
                <td>{user.sessions}</td>
                <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</td>
                <td>
                  <Link href={`${path}/${user.id}`}>Manage →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {users.length === 0 && (
        <p className="readout">
          {org.users === 0
            ? 'No people yet. Invite the first owner to get started.'
            : 'No people match these filters.'}
        </p>
      )}
      <AdminPagination
        path={path}
        page={page}
        total={total}
        filters={{ q, ...(role ? { role } : {}), ...(status ? { status } : {}) }}
      />
    </div>
  );
}
