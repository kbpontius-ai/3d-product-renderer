'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConfirm } from '@/components/confirm-dialog';
import { describeAccessChange } from '@/lib/access-change';

/**
 * Invitations, the same for staff and for an organisation's owner (F-AUTH-01, F-ORG-02).
 *
 * Both used to offer invite and nothing after it: an invited person's row had Suspend and Delete,
 * or Suspend and Make owner, but no way to send the link again or take it back. The routes differ —
 * staff name the organisation, an owner's is their own — so the endpoint is a prop and everything
 * else is shared.
 */

export interface InvitationResult {
  email: string;
  delivered: boolean;
  notDelivered?: string;
  /** Development only. */
  url?: string;
}

/** What happened to an invitation that was just made or resent — including when no email went. */
export function InvitationOutcome({ result, linkTestId }: { result: InvitationResult; linkTestId: string }) {
  return (
    <p className={result.delivered ? 'admin-ok' : 'admin-warn'} data-testid="invite-outcome">
      {result.delivered
        ? `Invitation emailed to ${result.email}.`
        : `Invitation created for ${result.email}, but no email was sent: ${result.notDelivered}.`}
      {result.url && (
        <span className="admin-link" data-testid={linkTestId}>
          {' '}
          Development link: <code>{result.url}</code>
        </span>
      )}
    </p>
  );
}

/** Resend and Revoke, for a row whose person has not accepted yet. */
export function InvitationActions({
  email,
  endpoint,
  orgId,
  returnHref,
}: {
  email: string;
  endpoint: '/api/admin/invitations' | '/api/org/invitations';
  /** Staff only: which organisation the invitation belongs to. */
  orgId?: string;
  returnHref?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InvitationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const resend = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, action: 'resend', ...(orgId ? { orgId } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as InvitationResult & { error?: { detail?: string } };
      if (!response.ok) setError(body.error?.detail ?? 'the invitation could not be resent');
      else setResult(body);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!(await confirm(describeAccessChange({ kind: 'revoke-invitation' }, { email })))) return;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ email, ...(orgId ? { orgId } : {}) });
      const response = await fetch(`${endpoint}?${query}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { detail?: string } };
        setError(body.error?.detail ?? 'the invitation could not be revoked');
        return;
      }
      if (returnHref) router.replace(returnHref);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" disabled={busy} onClick={() => void resend()} data-testid={`resend-${email}`}>
        Resend
      </button>
      <button type="button" className="danger" disabled={busy} onClick={() => void revoke()} data-testid={`revoke-${email}`}>
        Revoke
      </button>
      {result && <InvitationOutcome result={result} linkTestId={`resend-link-${email}`} />}
      {error && <small className="admin-error">{error}</small>}
      {dialog}
    </>
  );
}
