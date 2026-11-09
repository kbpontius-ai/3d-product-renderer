'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * "Start a design" — creates one against a catalog variant and opens it.
 *
 * The design exists on the server before the editor loads, so autosave has something to save to
 * from the first drag rather than having to invent a design mid-gesture.
 */
export function NewDesignButton({
  variantId,
  label = 'Start a design',
  testId,
}: {
  variantId: string;
  label?: string;
  testId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/designs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ variantId }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? 'Your session expired.' : 'Could not start a design.');
        return;
      }
      const design = (await response.json()) as { id: string };
      router.push(`/design/${design.id}`);
    } catch {
      setError('Could not start a design.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="auth-link" disabled={busy} onClick={() => void create()} data-testid={testId}>
        {busy ? 'Starting…' : label}
      </button>
      {error && <p className="issue error">{error}</p>}
    </>
  );
}
