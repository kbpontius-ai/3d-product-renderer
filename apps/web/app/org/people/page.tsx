import { listMembers } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { actorFor, requireOwner } from '@/lib/server/org';
import { InviteForm } from './invite-form';
import { MemberRow } from './member-row';

/** Everybody in this organisation, and nobody else (F-ORG-02). */
export const dynamic = 'force-dynamic';

export default async function OrgPeoplePage() {
  const principal = await requireOwner();
  const members = await listMembers(getSql(), actorFor(principal));

  return (
    <section>
      <header className="admin-head">
        <div>
          <h1>People</h1>
          <p className="auth-sub">
            {members.length} {members.length === 1 ? 'person' : 'people'} in this organization.
          </p>
        </div>
        <InviteForm />
      </header>

      <div className="table-wrap">
        <table className="admin-table" data-testid="member-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Products</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <MemberRow key={member.id} member={member} isSelf={member.id === principal.userId} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
