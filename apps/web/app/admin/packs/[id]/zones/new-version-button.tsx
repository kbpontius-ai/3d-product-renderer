'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useHydrated } from '@/lib/use-hydrated';

/** Copies a published pack into a new draft version, and opens that draft's zones. */
export function NewVersionButton({
  packId,
  next = 'zones',
}: {
  packId: string;
  next?: 'zones' | 'setup';
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [state, setState] = useState<'idle' | 'working'>('idle');
  const [error, setError] = useState<string | null>(null);

  const draft = async () => {
    setState('working');
    setError(null);
    const response = await fetch(`/api/admin/packs/${packId}/versions`, { method: 'POST' });
    const body = (await response.json().catch(() => ({}))) as {
      packId?: string;
      error?: { detail?: string };
    };
    if (!response.ok || !body.packId) {
      setError(body.error?.detail ?? 'the new version could not be made');
      setState('idle');
      return;
    }
    router.push(
      `/admin/packs/${body.packId}/${next}${next === 'setup' ? '?step=orientation' : ''}`,
    );
  };

  return (
    <span className="admin-form-actions">
      <button
        type="button"
        disabled={state === 'working'}
        onClick={() => void draft()}
        data-testid="new-draft-version"
        data-hydrated={hydrated || undefined}
      >
        {state === 'working' ? 'Making a draft…' : 'Make a new draft version'}
      </button>
      {error && <span className="admin-error">{error}</span>}
    </span>
  );
}
