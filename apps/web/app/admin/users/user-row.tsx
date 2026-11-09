'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConfirm } from '@/components/confirm-dialog';
import { InvitationActions } from '@/components/invitation-controls';
import { describeAccessChange, type AccessChange, type AccessRole } from '@/lib/access-change';
import type { UserRecord } from '@pr/admin';

/**
 * One account, with the things staff do to it: change its role, suspend, restore, remove.
 *
 * Every one of them changes what somebody can reach, so every one asks first and says what will
 * happen — a role select used to apply on change, and one click on it took a staff member out of
 * the console. Your own row offers none of them: the server refuses them too.
 */
export function UserRow({
  user,
  showOrg = false,
  isSelf = false,
  returnHref,
}: {
  user: UserRecord;
  showOrg?: boolean;
  isSelf?: boolean;
  returnHref?: string;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/users/${user.id}?orgId=${user.orgId}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { detail?: string } };
        setError(body.error?.detail ?? 'that did not work');
        return;
      }
      if (init.method === 'DELETE' && returnHref) router.replace(returnHref);
      router.refresh();
    } catch {
      setError('The request could not be completed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmThen = async (change: AccessChange, init: RequestInit) => {
    if (await confirm(describeAccessChange(change, { email: user.email, orgName: user.orgName })))
      await act(init);
  };

  const suspended = user.status === 'suspended';

  return (
    <tr data-testid={`user-${user.email}`}>
      <td>
        <strong>{user.email}</strong>
        {isSelf && <span className="chip"> you</span>}
        {error && <small className="admin-error">{error}</small>}
        {dialog}
      </td>
      {showOrg && <td>{user.orgName}</td>}
      <td>
        {isSelf ? (
          // Changing your own role is how a staff member once locked themselves out of the console.
          <span
            data-testid={`role-${user.email}`}
            title="Another staff member can change your role."
          >
            {user.role}
          </span>
        ) : (
          <select
            value={user.role}
            disabled={busy}
            data-testid={`role-${user.email}`}
            // Controlled by the stored role, so a cancelled change leaves the select where it was.
            onChange={(e) => {
              const to = e.target.value as AccessRole;
              void confirmThen(
                { kind: 'role', from: user.role as AccessRole, to },
                { method: 'PATCH', body: JSON.stringify({ role: to }) },
              );
            }}
          >
            <option value="member">member</option>
            <option value="owner">owner</option>
            <option value="staff">staff</option>
          </select>
        )}
      </td>
      <td>
        <span className={suspended ? 'pill warn' : user.status === 'active' ? 'pill ok' : 'pill'}>
          {user.status}
        </span>
      </td>
      <td>{user.sessions}</td>
      <td className="admin-row-actions">
        {isSelf ? null : user.status === 'invited' ? (
          // Nothing to suspend or delete yet: somebody who has not accepted needs the link again, or
          // taken back.
          <InvitationActions
            email={user.email}
            endpoint="/api/admin/invitations"
            orgId={user.orgId}
            returnHref={returnHref}
          />
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              data-testid={`toggle-${user.email}`}
              onClick={() =>
                void confirmThen(
                  { kind: suspended ? 'restore' : 'suspend' },
                  {
                    method: 'PATCH',
                    body: JSON.stringify({ status: suspended ? 'active' : 'suspended' }),
                  },
                )
              }
            >
              {suspended ? 'Restore' : 'Suspend'}
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              data-testid={`delete-${user.email}`}
              onClick={() => void confirmThen({ kind: 'delete' }, { method: 'DELETE' })}
            >
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
