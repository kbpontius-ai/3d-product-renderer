'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { InvitationOutcome, type InvitationResult } from '@/components/invitation-controls';

/**
 * Inviting someone (F-AUTH-01, and the reason the dev-only invite endpoint existed).
 *
 * The link is emailed and never shown here outside development: the inviter holding it could accept
 * for somebody else. What is shown is whether the email actually went, and why not when it did not.
 */
export function InviteForm({
  orgId,
  defaultRole = 'member',
}: {
  orgId: string;
  defaultRole?: 'member' | 'owner';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InvitationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read from the form, not from state: an address typed before the page hydrated never reached
  // React state, and the button it gated stayed disabled with the address sitting in the field.
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const role = data.get('role') === 'owner' ? 'owner' : 'member';
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/admin/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, email, role }),
      });
      const body = (await response.json()) as InvitationResult & { error?: { detail?: string } };
      if (!response.ok) {
        setError(body.error?.detail ?? 'that did not work');
        return;
      }
      setResult(body);
      form.reset();
      router.refresh();
    } catch {
      setError('The request could not be completed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={(e) => void submit(e)} data-testid="invite-form">
      <label>
        Email
        <input type="email" name="email" required data-testid="invite-email" />
      </label>
      <label>
        Role
        <select name="role" defaultValue={defaultRole} data-testid="invite-role">
          <option value="member">Member</option>
          <option value="owner">Owner</option>
        </select>
      </label>
      <div className="admin-form-actions">
        <button type="submit" disabled={busy} data-testid="invite-submit">
          {busy ? 'Sending…' : 'Send invitation'}
        </button>
        {error && <span className="admin-error">{error}</span>}
      </div>
      {result && <InvitationOutcome result={result} linkTestId="invite-link" />}
    </form>
  );
}
