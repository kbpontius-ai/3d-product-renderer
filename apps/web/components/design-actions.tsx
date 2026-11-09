'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConfirm } from '@/components/confirm-dialog';

/**
 * Rename, duplicate and delete, from the design list (F-PROJ-01).
 *
 * Deletion is soft and reversible for a month, which is why it asks once rather than twice.
 */
export function DesignActions({
  designId,
  name,
  readOnly = false,
}: {
  designId: string;
  name: string;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'copy' | 'delete' | 'rename' | null>(null);
  const { confirm, prompt, dialog } = useConfirm();

  const rename = async () => {
    const next = await prompt({
      title: 'Rename this design',
      input: { label: 'Name', defaultValue: name },
      confirmLabel: 'Rename',
    });
    if (!next) return;

    setBusy('rename');
    await fetch(`/api/designs/${designId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: next }),
    });
    setBusy(null);
    router.refresh();
  };

  const duplicate = async () => {
    setBusy('copy');
    const response = await fetch(`/api/designs/${designId}/duplicate`, { method: 'POST' });
    setBusy(null);
    if (response.ok) {
      const copy = (await response.json()) as { id: string };
      router.push(`/design/${copy.id}`);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${name}”?`,
      consequences: ['It moves to Recently deleted, where it can be restored for 30 days.'],
      confirmLabel: 'Delete design',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('delete');
    await fetch(`/api/designs/${designId}`, { method: 'DELETE' });
    setBusy(null);
    router.refresh();
  };

  return (
    <details className="design-actions">
      <summary aria-label={`Actions for ${name}`}>⋯</summary>
      <div className="design-actions-menu">
        <button
          type="button"
          onClick={() => void rename()}
          disabled={readOnly || busy !== null}
          data-testid={`rename-${designId}`}
        >
          {busy === 'rename' ? 'Renaming…' : 'Rename'}
        </button>
        <button type="button" onClick={() => void duplicate()} disabled={readOnly || busy !== null}>
          {busy === 'copy' ? 'Copying…' : 'Duplicate'}
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy !== null}
          data-testid={`delete-${designId}`}
        >
          {busy === 'delete' ? 'Deleting…' : 'Delete'}
        </button>
      </div>
      {dialog}
    </details>
  );
}
