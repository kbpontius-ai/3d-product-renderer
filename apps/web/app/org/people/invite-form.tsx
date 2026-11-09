'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { InvitationOutcome, type InvitationResult } from '@/components/invitation-controls';

/**
 * Inviting somebody into this organisation.
 *
 * No organisation field: it comes from the session. The role offers owner and member and nothing
 * else — `staff` is not a role an organisation grants itself, and the route refuses it too.
 */
export function InviteForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<InvitationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read from the form, not from state: an address typed before the page hydrated never reached
  // React state, so it would have been sent as an empty string.
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const role = data.get('role') === 'owner' ? 'owner' : 'member';
    setError(null);
    setResult(null);
    start(async () => {
      const response = await fetch('/api/org/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const payload = (await response.json().catch(() => ({}))) as InvitationResult & {
        message?: string;
        error?: { detail?: string };
      };
      if (!response.ok) {
        setError(payload.error?.detail ?? payload.message ?? 'That did not work.');
        return;
      }
      setResult(payload);
      form.reset();
      router.refresh();
    });
  };

  return (
    <form className="admin-inline-form" onSubmit={submit} data-testid="org-invite-form">
      <input type="email" name="email" required placeholder="name@company.com" data-testid="org-invite-email" />
      <select name="role" defaultValue="member" data-testid="org-invite-role">
        <option value="member">Member</option>
        <option value="owner">Owner</option>
      </select>
      <button type="submit" disabled={pending} data-testid="org-invite-submit">
        <span className="loading-inline">{pending && <LoadingSpinner compact />}{pending ? 'Inviting…' : 'Invite'}</span>
      </button>

      {result && <InvitationOutcome result={result} linkTestId="org-invite-link" />}
      {error && (
        <span className="issue error" data-testid="org-invite-error">
          {error}
        </span>
      )}
    </form>
  );
}
