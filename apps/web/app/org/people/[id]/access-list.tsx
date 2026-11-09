'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PackSummary } from '@pr/admin';

/**
 * Which products this member may start designs on.
 *
 * Checked means allowed, and everything starts checked — access is deny-by-exception, so a product
 * added to the organisation tomorrow reaches this person without anybody coming back here.
 */
export function AccessList({
  memberId,
  packs,
  withheld,
}: {
  memberId: string;
  packs: PackSummary[];
  withheld: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /*
   * The box moves when you click it, not when the server agrees.
   *
   * `checked` came straight from the props at first, which made this a controlled input whose value
   * could only change after a round trip and a refresh — so the box visibly snapped back and stayed
   * wrong for as long as the request took. React reverts the optimistic value on its own when the
   * transition ends, which means a refusal from the server un-ticks it without any bookkeeping here.
   */
  const [denied, applyLocally] = useOptimistic(
    withheld,
    (current: string[], change: { packId: string; allowed: boolean }) =>
      change.allowed
        ? current.filter((id) => id !== change.packId)
        : [...current, change.packId],
  );

  const set = (packId: string, allowed: boolean) => {
    setError(null);
    start(async () => {
      applyLocally({ packId, allowed });

      const response = await fetch(`/api/org/members/${memberId}/access`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packId, allowed }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as { message?: string };
        setError(problem.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    });
  };

  return (
    <div data-testid="access-list">
      <h2>Products</h2>
      <p className="readout">
        Taking a product away removes it from this person’s catalog. Designs they have already made
        on it stay where they are, and any render already queued still finishes.
      </p>

      {packs.length === 0 && <p className="readout">This organization has no published products yet.</p>}

      <ul className="admin-checklist">
        {packs.map((pack) => (
          <li key={pack.id}>
            <label>
              <input
                type="checkbox"
                checked={!denied.includes(pack.id)}
                disabled={pending}
                onChange={(event) => set(pack.id, event.target.checked)}
                data-testid={`access-${pack.key}`}
              />
              {pack.name}
              <span className="chip">{pack.version}</span>
            </label>
          </li>
        ))}
      </ul>

      {error && (
        <p className="issue error" data-testid="access-error">
          {error}
        </p>
      )}
    </div>
  );
}
