'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConfirm } from '@/components/confirm-dialog';

/**
 * Removing a render from the gallery (F-REND-07).
 *
 * One button, because a person does not distinguish: a render still going is cancelled, a finished
 * one is deleted, and the route decides which. Deleting also frees the design to be rendered again
 * at the same settings, which is usually why someone is deleting it.
 */
export function RenderActions({ jobId, live }: { jobId: string; live: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  const remove = async () => {
    if (
      !live &&
      !(await confirm({
        title: 'Delete this render?',
        consequences: [
          'The image and its downloads go with it. This cannot be undone.',
          'The design itself is kept, and can be rendered again at the same settings.',
        ],
        confirmLabel: 'Delete render',
        tone: 'danger',
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/renders/${jobId}`, { method: 'DELETE' });
      if (response.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="auth-link danger"
        disabled={busy}
        onClick={() => void remove()}
        data-testid={`render-remove-${jobId}`}
      >
        {busy ? '…' : live ? 'Cancel' : 'Delete'}
      </button>
      {dialog}
    </>
  );
}
