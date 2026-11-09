import { notFound } from 'next/navigation';
import { AdminError, getMember, listOrgPacks } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { actorFor, requireOwner } from '@/lib/server/org';
import { AccessList } from './access-list';

/** One person, and which products they may start a design on (F-ORG-03). */
export const dynamic = 'force-dynamic';

export default async function OrgMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireOwner();
  const { id } = await params;

  const member = await getMember(getSql(), actorFor(principal), id).catch((error: unknown) => {
    // Somebody else's employee is not a person this owner may be told about.
    if (error instanceof AdminError && error.code === 'not_found') notFound();
    throw error;
  });
  const packs = await listOrgPacks(getSql(), actorFor(principal));

  return (
    <section data-testid="member-detail">
      <header className="admin-head">
        <div>
          <h1>{member.email}</h1>
          <p className="auth-sub">
            {member.role} · {member.status}
            {member.lastLoginAt ? ` · last signed in ${new Date(member.lastLoginAt).toLocaleDateString()}` : ''}
          </p>
        </div>
      </header>

      {member.role === 'member' ? (
        <AccessList memberId={member.id} packs={packs} withheld={member.withheldPackIds} />
      ) : (
        <p className="readout" data-testid="access-not-applicable">
          {member.role === 'owner'
            ? 'Owners see the whole catalog — they administer it.'
            : 'Staff accounts are administered by support.'}
        </p>
      )}
    </section>
  );
}
