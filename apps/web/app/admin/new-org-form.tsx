'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Creating an organisation: the one step that has to happen before anyone can be invited. */
export function NewOrgForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The slug is derived from the name; an administrator who wants a different one can
        // change it once, rather than typing two things that must agree.
        body: JSON.stringify({ name, slug: name }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { detail?: string } };
        setError(body.error?.detail ?? 'that did not work');
        return;
      }
      setName('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-inline-form" onSubmit={(e) => void submit(e)}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New organization"
        required
        data-testid="new-org-name"
      />
      <button type="submit" disabled={busy || !name.trim()} data-testid="new-org-submit">
        {busy ? 'Creating…' : 'Create'}
      </button>
      {error && <span className="admin-error">{error}</span>}
    </form>
  );
}
