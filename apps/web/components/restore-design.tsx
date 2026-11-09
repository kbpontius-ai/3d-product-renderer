'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Getting a deleted design back, inside the window (F-PROJ-01). */
export function RestoreDesign({ designId }: { designId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      data-testid={`restore-${designId}`}
      onClick={() => {
        setBusy(true);
        void fetch(`/api/designs/${designId}/restore`, { method: 'POST' })
          .then(() => router.refresh())
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Restoring…' : 'Restore'}
    </button>
  );
}
