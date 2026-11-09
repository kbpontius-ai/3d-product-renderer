'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { MemberRecord } from '@pr/admin';
import { useConfirm } from '@/components/confirm-dialog';
import { InvitationActions } from '@/components/invitation-controls';
import { describeAccessChange, type AccessChange } from '@/lib/access-change';

/**
 * One person, with the two things an owner does to them.
 *
 * Deliberately no remove: suspension locks the account out of both sign-in and session resolution
 * and keeps every design they made, so it covers somebody leaving and it can be taken back.
 * Deletion is irreversible and stays with staff.
 */
export function MemberRow({ member, isSelf }: { member: MemberRecord; isSelf: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  // Each of these changes what somebody can reach, so each asks first and says what will happen.
  const confirmThen = async (change: AccessChange, body: Record<string, string>) => {
    if (await confirm(describeAccessChange(change, { email: member.email, orgName: 'this organization' }))) patch(body);
  };

  const patch = (body: Record<string, string>) => {
    setError(null);
    start(async () => {
      const response = await fetch(`/api/org/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as { message?: string };
        setError(problem.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    });
  };

  const suspended = member.status === 'suspended';
  // Staff accounts appear here because they belong to the organisation, but an owner does not
  // administer them — the operations refuse it, so the controls say so rather than inviting a click
  // that fails.
  const managed = member.role !== 'staff' && !isSelf;

  return (
    <tr data-testid={`member-${member.id}`} data-status={member.status}>
      <td>
        <a href={`/org/people/${member.id}`}>{member.email}</a>
        {isSelf && <span className="chip"> you</span>}
        {dialog}
      </td>
      <td data-testid={`member-role-${member.id}`}>{member.role}</td>
      <td data-testid={`member-status-${member.id}`}>{member.status}</td>
      <td>
        {member.role === 'member'
          ? member.withheldPackIds.length === 0
            ? 'all'
            : `${member.withheldPackIds.length} withheld`
          : 'all'}
      </td>
      <td className="admin-actions">
        {managed && member.status === 'invited' && (
          // Not accepted yet: nothing to suspend. Send the link again, or take it back.
          <InvitationActions email={member.email} endpoint="/api/org/invitations" />
        )}
        {managed && member.status !== 'invited' && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void confirmThen({ kind: suspended ? 'restore' : 'suspend' }, { status: suspended ? 'active' : 'suspended' })
              }
              data-testid={`member-suspend-${member.id}`}
            >
              {suspended ? 'Reinstate' : 'Suspend'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                const to = member.role === 'owner' ? 'member' : 'owner';
                void confirmThen({ kind: 'role', from: member.role === 'owner' ? 'owner' : 'member', to }, { role: to });
              }}
              data-testid={`member-role-toggle-${member.id}`}
            >
              Make {member.role === 'owner' ? 'member' : 'owner'}
            </button>
          </>
        )}
        {error && (
          <span className="issue error" data-testid={`member-error-${member.id}`}>
            {error}
          </span>
        )}
      </td>
    </tr>
  );
}
