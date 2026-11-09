'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useConfirm } from '@/components/confirm-dialog';
import type { PackSummary } from '@pr/catalog';

/**
 * One pack: what it contains, who can see it, and whether it is still offered.
 *
 * Deprecating warns when designs are using it. Those designs keep working — they pin the variant
 * they were made against — but nobody should retire a pack without knowing how many customers are
 * standing on it.
 */
export function PackRow({
  pack,
  orgs,
  replaces,
}: {
  pack: PackSummary;
  orgs: { id: string; name: string }[];
  /** The version of this pack that is published now, which publishing this one retires. */
  replaces?: string | undefined;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { confirm, dialog } = useConfirm();

  const patch = async (body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/packs/${pack.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: { detail?: string } };
        setError(payload.error?.detail ?? 'that did not work');
        return;
      }
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleOrg = (orgId: string) => {
    const next = pack.visibleToOrgIds.includes(orgId)
      ? pack.visibleToOrgIds.filter((id) => id !== orgId)
      : [...pack.visibleToOrgIds, orgId];
    void patch({ visibleToOrgIds: next });
  };

  return (
    <tr data-testid={`pack-${pack.key}-${pack.version}`} data-status={pack.status}>
      <td>
        {dialog}
        <strong>{pack.name}</strong>
        <small>
          {pack.key}@{pack.version}
        </small>
        {error && <small className="admin-error">{error}</small>}
      </td>
      <td>
        <small>
          {pack.products} product(s), {pack.variants} variant(s), {pack.zones} zone(s)
        </small>
      </td>
      <td>{pack.designs}</td>
      <td>
        {editing ? (
          <div className="pack-visibility" data-testid={`visibility-${pack.key}`}>
            {orgs.map((org) => (
              <label key={org.id}>
                <input
                  type="checkbox"
                  checked={pack.visibleToOrgIds.includes(org.id)}
                  disabled={busy}
                  onChange={() => toggleOrg(org.id)}
                />
                {org.name}
              </label>
            ))}
            <button type="button" onClick={() => setEditing(false)}>
              Done
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="linkish"
            onClick={() => setEditing(true)}
            data-testid={`edit-visibility-${pack.key}`}
          >
            {pack.visibleToOrgIds.length === 0
              ? 'Everyone'
              : `${pack.visibleToOrgIds.length} organization(s)`}
          </button>
        )}
      </td>
      <td>
        <span
          className={
            pack.status === 'published' ? 'pill ok' : pack.status === 'draft' ? 'pill warn' : 'pill'
          }
        >
          {pack.status}
        </span>
      </td>
      <td className="admin-row-actions">
        <div className="pack-actions">
          {/* In the order a pack is set up; links, so each can open in its own tab. */}
          <nav className="pack-setup" aria-label={`Set up ${pack.key}@${pack.version}`}>
            <a href={`/admin/packs/${pack.id}/setup?step=orientation`}>Orientation</a>
            <a href={`/admin/packs/${pack.id}/zones`} data-testid={`zones-${pack.key}`}>
              Zones
            </a>
            <a href={`/admin/packs/${pack.id}/thumbnails`}>Catalog previews</a>
          </nav>
          <span className="pack-actions-divider" aria-hidden="true" />
          {pack.status !== 'published' && (
            <button
              type="button"
              className={pack.status === 'draft' ? 'primary' : undefined}
              disabled={busy}
              data-testid={`publish-${pack.key}`}
              onClick={() =>
                // Publishing is where a pack's zones stop being editable in place, and — when another
                // version is live — where that version leaves the catalog. Both deserve a moment.
                void confirm({
                  title: `Publish ${pack.key}@${pack.version}?`,
                  consequences: [
                    'It appears in the catalog for every organization allowed to see it.',
                    'Its zones are fixed in place: moving or removing one later means making a new draft version.',
                    ...(replaces
                      ? [
                          `It replaces ${pack.key}@${replaces} in the catalog; designs already made on ${replaces} keep working on it.`,
                        ]
                      : []),
                  ],
                  confirmLabel: 'Publish',
                }).then((ok) => {
                  if (ok) void patch({ status: 'published' });
                })
              }
            >
              Publish
            </button>
          )}
          {pack.status === 'published' && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              data-testid={`deprecate-${pack.key}`}
              onClick={() =>
                void confirm({
                  title: `Deprecate ${pack.key}@${pack.version}?`,
                  consequences: [
                    'It leaves the catalog: nobody can start a new design on it.',
                    pack.designs > 0
                      ? `${pack.designs} design${pack.designs === 1 ? '' : 's'} already use it, and keep working on it.`
                      : 'No design uses it yet.',
                  ],
                  confirmLabel: 'Deprecate',
                  tone: 'danger',
                }).then((ok) => {
                  if (ok) void patch({ status: 'deprecated' });
                })
              }
            >
              Deprecate
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
