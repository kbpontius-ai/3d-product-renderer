import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import {
  AdminError,
  countUsers,
  getUser,
  getMember,
  invitationExpiry,
  listOrgPacks,
} from '@pr/admin';
import { requireStaff } from '@/lib/server/admin';
import { getAdminOrganization } from '@/lib/server/admin-org';
import { getSql } from '@/lib/server/db';
import { UserRow } from '../../../../users/user-row';

export default async function OrganizationPerson({
  params,
}: {
  params: Promise<{ id: string; userId: string }>;
}) {
  const principal = await requireStaff();
  const { id, userId } = await params;
  const org = await getAdminOrganization(id);
  if (!z.string().uuid().safeParse(userId).success) notFound();
  const user = await getUser(getSql(), userId, id).catch((error: unknown) => {
    if (error instanceof AdminError && error.code === 'not_found') notFound();
    throw error;
  });
  const actor = { userId: principal.userId, orgId: id, role: principal.role };
  const [member, packs, expiresAt, owners] = await Promise.all([
    getMember(getSql(), actor, userId),
    listOrgPacks(getSql(), actor),
    user.status === 'invited' ? invitationExpiry(getSql(), id, user.email) : Promise.resolve(null),
    countUsers(getSql(), { orgId: id, role: 'owner', status: 'active' }),
  ]);
  const path = `/admin/orgs/${id}/people`;
  const expired = expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();
  return (
    <div data-testid="org-person">
      <Link className="org-breadcrumb" href={path}>
        ← People in {org.name}
      </Link>
      <header className="org-section-head">
        <h2>{user.email}</h2>
        <p className="auth-sub">
          {user.role} · {user.status}
        </p>
      </header>
      <section className="org-panel">
        <h3>Account access</h3>
        <dl className="org-person-facts">
          <div>
            <dt>Effective access</dt>
            <dd>
              {org.status === 'suspended'
                ? 'Organization suspended — sign-in blocked'
                : user.status === 'invited'
                  ? 'Awaiting invitation acceptance'
                  : user.status === 'suspended'
                    ? 'Account suspended — sign-in blocked'
                    : user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()
                      ? 'Sign-in temporarily locked'
                      : 'Account active'}
            </dd>
          </div>
          <div>
            <dt>Last signed in</dt>
            <dd>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</dd>
          </div>
          <div>
            <dt>Joined / invited</dt>
            <dd>{new Date(user.createdAt).toLocaleDateString()}</dd>
          </div>
          {user.status === 'invited' && (
            <div>
              <dt>Invitation link</dt>
              <dd>
                {expiresAt
                  ? `${expired ? 'Expired' : 'Expires'} ${new Date(expiresAt).toLocaleString()}`
                  : 'No outstanding link recorded'}
              </dd>
            </div>
          )}
        </dl>
        {user.status === 'invited' && (
          <p className={expired ? 'admin-warn' : 'auth-sub'}>
            {expired
              ? 'The link has expired. Resend creates a fresh invitation link.'
              : 'Resend creates a fresh link. Revoke removes the pending account.'}
          </p>
        )}
        {user.role === 'owner' && user.status === 'active' && owners === 1 && (
          <p className="admin-warn" data-testid="last-owner-warning">
            This is the only active owner. Add another active owner before demoting, suspending or
            deleting this account.
          </p>
        )}
        <div className="table-wrap">
          <table className="admin-table" data-testid="person-controls">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Sessions</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <UserRow user={user} isSelf={user.id === principal.userId} returnHref={path} />
            </tbody>
          </table>
        </div>
        <p className="auth-sub">
          Suspension ends sessions. Designs, artwork and renders stay with {org.name} when an
          account is removed.
        </p>
      </section>
      <section className="org-panel org-person-products">
        <h3>Product access</h3>
        <p className="auth-sub">
          {user.role === 'member'
            ? 'Current member restrictions. Owners manage these in their Organization area.'
            : 'Owners and staff see the whole organization catalog.'}
        </p>
        <ul className="org-access-readout">
          {packs.map((pack) => (
            <li key={pack.id}>
              <span>
                {pack.name} <small>v{pack.version}</small>
              </span>
              <span
                className={
                  user.role === 'member' && member.withheldPackIds.includes(pack.id)
                    ? 'pill warn'
                    : 'pill ok'
                }
              >
                {user.role === 'member' && member.withheldPackIds.includes(pack.id)
                  ? 'Withheld'
                  : 'Available'}
              </span>
            </li>
          ))}
        </ul>
        {packs.length === 0 && <p className="auth-sub">No published products available.</p>}
        <Link href={`/admin/orgs/${id}/products`}>View organization products →</Link>
      </section>
    </div>
  );
}
