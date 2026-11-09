'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Creating a material outside any pack.
 *
 * Most materials arrive with a pack, but an operator matching a customer's brand plastic needs one
 * that belongs to the library rather than to a product — and that survives the next re-import of
 * the pack it would otherwise have lived in.
 */

const FAMILIES = ['plastic', 'metal', 'paperboard', 'glass', 'ink', 'foil', 'coating'] as const;

export function NewMaterialForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [family, setFamily] = useState<(typeof FAMILIES)[number]>('plastic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const response = await fetch('/api/admin/materials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key,
          name: name.trim(),
          family,
          // Sensible neutral defaults; every number is adjustable on the card afterwards.
          definition: { base: { baseColorHex: '#cccccc', roughness: 0.4 }, maps: {} },
        }),
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
        placeholder="New material"
        required
        data-testid="new-material-name"
      />
      <select value={family} onChange={(e) => setFamily(e.target.value as (typeof FAMILIES)[number])} data-testid="new-material-family">
        {FAMILIES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy || !name.trim()} data-testid="new-material-submit">
        {busy ? 'Creating…' : 'Create'}
      </button>
      {error && <span className="admin-error">{error}</span>}
    </form>
  );
}
