'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConfirm } from '@/components/confirm-dialog';

/**
 * Replaying everything that failed.
 *
 * The move after an outage: the renderer was broken for an hour, it is fixed, and nobody wants to
 * click retry two hundred times. Bounded and confirmed, because it can put real load on the farm.
 */
export function RetryFailed({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const { confirm, dialog } = useConfirm();

  if (count === 0) return null;

  const run = async () => {
    const batch = Math.min(count, 50);
    const ok = await confirm({
      title: `Requeue ${batch === count ? 'all' : 'up to'} ${batch} failed render${batch === 1 ? '' : 's'}?`,
      consequences: [
        'Each goes back in the queue with its attempts reset, newest failures first.',
        'They compete with new work for the render workers until they finish.',
      ],
      confirmLabel: 'Requeue',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const response = await fetch('/api/admin/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'retry-failed' }),
      });
      const body = (await response.json()) as { requeued?: number };
      setDone(body.requeued ?? 0);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-inline-form">
      <button type="button" disabled={busy} onClick={() => void run()} data-testid="retry-failed">
        {busy ? 'Requeueing…' : `Retry ${count} failed`}
      </button>
      {done !== null && <span className="admin-ok" data-testid="retry-failed-done">{done} requeued</span>}
      {dialog}
    </div>
  );
}
