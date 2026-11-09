'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useCallback, useEffect, useState } from 'react';
import type { StoredArtwork } from '@/lib/editor-data';
import { useConfirm } from '@/components/confirm-dialog';

/**
 * The organisation's artwork, ready to place again (F-ART-06).
 *
 * A logo is uploaded once and used on every product, so the library is the normal way to start a
 * design; uploading is what you do the first time. Thumbnails are the pipeline's own coverage
 * masks — the shape that will actually be cut, rather than a picture of the file.
 */
export function ArtworkLibrary({
  disabled = false,
  currentVersionId,
  initiallyOpen = false,
  onChoose,
}: {
  disabled?: boolean;
  currentVersionId: string | null;
  initiallyOpen?: boolean;
  onChoose: (artwork: StoredArtwork) => void;
}) {
  const [artworks, setArtworks] = useState<StoredArtwork[] | null>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [error, setError] = useState<string | null>(null);
  const { confirm, prompt, dialog } = useConfirm();

  const load = useCallback(async () => {
    const response = await fetch('/api/artworks');
    if (!response.ok) {
      setArtworks([]);
      return;
    }
    const body = (await response.json()) as { artworks: StoredArtwork[] };
    setArtworks(body.artworks);
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [load, open, currentVersionId]);

  /** Rename and delete both come back as 204 or as a sentence worth showing. */
  const manage = useCallback(
    async (artworkId: string, init: RequestInit) => {
      setError(null);
      const response = await fetch(`/api/artworks/${artworkId}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { detail?: string; code?: string };
        };
        setError(body.error?.detail ?? body.error?.code ?? 'that did not work');
        return;
      }
      await load();
    },
    [load],
  );

  return (
    <div className="artwork-library">
      {dialog}
      <button
        type="button"
        className="library-toggle"
        onClick={() => setOpen((was) => !was)}
        disabled={disabled}
        data-testid="artwork-library-toggle"
      >
        {open ? 'Hide your artwork' : 'Use artwork you have already uploaded'}
      </button>

      {open && (
        <div data-testid="artwork-library">
          {error && (
            <p className="issue error" data-testid="library-error">
              {error}
            </p>
          )}
          {artworks === null && !error && <p className="readout loading-inline"><LoadingSpinner compact />Loading artwork…</p>}
          {artworks?.length === 0 && (
            <p className="readout" data-testid="artwork-library-empty">
              Nothing here yet. The first logo you upload appears in this list.
            </p>
          )}

          <ul className="library-grid">
            {artworks?.map((artwork) => (
              <li key={artwork.ref.versionId}>
                <button
                  type="button"
                  className={artwork.ref.versionId === currentVersionId ? 'chosen' : ''}
                  onClick={() => onChoose(artwork)}
                  data-testid={`library-${artwork.ref.versionId}`}
                  title={`${artwork.naturalSizeMm.w.toFixed(1)} × ${artwork.naturalSizeMm.h.toFixed(1)} mm`}
                >
                  <img src={artwork.maskUrl} alt="" />
                  <span>{artwork.name}</span>
                </button>
                <div className="library-actions">
                  <button
                    type="button"
                    data-testid={`rename-${artwork.ref.artworkId}`}
                    onClick={() =>
                      void prompt({
                        title: 'Rename this artwork',
                        input: { label: 'Name', defaultValue: artwork.name },
                        confirmLabel: 'Rename',
                      }).then((name) => {
                        if (name)
                          void manage(artwork.ref.artworkId, {
                            method: 'PATCH',
                            body: JSON.stringify({ name }),
                          });
                      })
                    }
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    data-testid={`delete-artwork-${artwork.ref.artworkId}`}
                    onClick={() =>
                      void confirm({
                        title: `Delete ${artwork.name}?`,
                        consequences: [
                          'It leaves your library.',
                          'Designs already using it keep it, exactly as placed.',
                        ],
                        confirmLabel: 'Delete artwork',
                        tone: 'danger',
                      }).then((ok) => {
                        if (ok) void manage(artwork.ref.artworkId, { method: 'DELETE' });
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
