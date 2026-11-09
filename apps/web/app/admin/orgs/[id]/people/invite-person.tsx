'use client';

import { useEffect, useRef, useState } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { InviteForm } from '../invite-form';

export function InvitePerson({
  orgId,
  orgName,
  firstOwner = false,
}: {
  orgId: string;
  orgName: string;
  firstOwner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const hydrated = useHydrated();
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
  }, [open]);
  return (
    <>
      <button
        className="primary"
        type="button"
        onClick={() => setOpen(true)}
        data-testid="invite-person"
        data-hydrated={hydrated || undefined}
      >
        {firstOwner ? 'Invite first owner' : 'Invite person'}
      </button>
      {open && (
        <dialog
          ref={ref}
          className="confirm-dialog org-invite-dialog"
          onCancel={() => setOpen(false)}
          data-testid="invite-person-dialog"
        >
          <div className="confirm-dialog-panel">
            <h2>Invite to {orgName}</h2>
            <p>They will receive a link to join this organization.</p>
            <InviteForm orgId={orgId} defaultRole={firstOwner ? 'owner' : 'member'} />
            <div className="confirm-dialog-actions">
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}
