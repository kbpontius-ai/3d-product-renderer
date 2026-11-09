import Link from 'next/link';
import { orgOverview } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { getAdminOrganization } from '@/lib/server/admin-org';

export default async function AdminOrgPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireStaff();
  const { id } = await params;
  const org = await getAdminOrganization(id);
  const overview = await orgOverview(getSql(), {
    userId: principal.userId,
    orgId: id,
    role: principal.role,
  });
  const base = `/admin/orgs/${id}`;
  return (
    <div data-testid="org-overview">
      <dl className="org-summary">
        <div>
          <dt>Active people</dt>
          <dd>{overview.seats.active}</dd>
        </div>
        <div>
          <dt>Pending invitations</dt>
          <dd>{overview.seats.invited}</dd>
        </div>
        <div>
          <dt>Renders today / daily limit</dt>
          <dd>
            {org.rendersToday} / {org.quotas.rendersPerDay}
          </dd>
        </div>
      </dl>
      <div className="admin-columns">
        <div>
          <h2>Organization access</h2>
          <p className="auth-sub">
            {org.status === 'active'
              ? 'People can sign in according to their account status and role.'
              : 'Sign-in is blocked for this organization.'}
          </p>
          <p>
            {org.users} people · {org.designs} designs
          </p>
          <Link className="org-action-link" href={`${base}/people`}>
            Manage people →
          </Link>
        </div>
        <div>
          <h2>{org.users === 0 ? 'Get started' : 'People to review'}</h2>
          <p className="auth-sub">
            {org.users === 0
              ? 'Invite the first owner so they can manage their organization.'
              : `${overview.seats.invited} awaiting acceptance · ${overview.seats.suspended} suspended.`}
          </p>
          <Link
            className="org-action-link"
            href={`${base}/people${org.users === 0 ? '?invite=owner' : '?status=invited'}`}
          >
            {org.users === 0 ? 'Invite first owner' : 'Review invitations'} →
          </Link>
        </div>
      </div>
    </div>
  );
}
