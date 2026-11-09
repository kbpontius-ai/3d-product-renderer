'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Quotas } from '@pr/admin';

/**
 * The limits, as numbers an administrator can change.
 *
 * Storage is shown in gigabytes because nobody reasons in bytes, and converted back on the way out
 * — the stored unit stays exact.
 */

const FIELDS: { key: keyof Quotas; label: string; help: string; scale?: number }[] = [
  { key: 'rendersPerDay', label: 'Renders per day', help: 'Submissions refused once reached.' },
  { key: 'maxConcurrentJobs', label: 'Concurrent renders', help: 'How much of the farm one org may hold.' },
  { key: 'gpuSecondsPerMonth', label: 'GPU seconds / month', help: 'Compute budget.' },
  { key: 'maxResolutionPx', label: 'Max resolution (px)', help: 'Longest side of a render.' },
  { key: 'storageBytes', label: 'Storage (GB)', help: 'Artwork, meshes and finished renders.', scale: 1024 ** 3 },
];

export function QuotaForm({ orgId, quotas }: { orgId: string; quotas: Quotas }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      FIELDS.map((field) => [field.key, String(Math.round(quotas[field.key] / (field.scale ?? 1)))]),
    ),
  );
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('saving');
    setError(null);

    const body: Partial<Quotas> = {};
    for (const field of FIELDS) {
      const raw = Number(values[field.key]);
      if (!Number.isFinite(raw)) continue;
      body[field.key] = Math.round(raw * (field.scale ?? 1));
    }

    const response = await fetch(`/api/admin/orgs/${orgId}/quotas`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: { detail?: string } };
      setError(payload.error?.detail ?? 'that did not work');
      setState('error');
      return;
    }

    setState('saved');
    router.refresh();
  };

  return (
    <form className="admin-form" onSubmit={(e) => void submit(e)} data-testid="quota-form">
      {FIELDS.map((field) => (
        <label key={field.key}>
          {field.label}
          <input
            type="number"
            min={0}
            value={values[field.key] ?? ''}
            data-testid={`quota-${field.key}`}
            onChange={(e) => setValues((current) => ({ ...current, [field.key]: e.target.value }))}
          />
          <small>{field.help}</small>
        </label>
      ))}
      <div className="admin-form-actions">
        <button type="submit" disabled={state === 'saving'} data-testid="quota-save">
          {state === 'saving' ? 'Saving…' : 'Save limits'}
        </button>
        {state === 'saved' && <span className="admin-ok" data-testid="quota-saved">Saved</span>}
        {error && <span className="admin-error">{error}</span>}
      </div>
    </form>
  );
}
