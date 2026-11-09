'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Upload, MoreHorizontal } from 'lucide-react';
import type { StoredArtwork } from '@/lib/editor-data';
import { artworkRequest } from '@/lib/artwork-api';
import { useHydrated } from '@/lib/use-hydrated';
import dynamic from 'next/dynamic';
import { readPreparationFile } from '@/lib/artwork-preparation-file';
import type { PreparationEntry } from './artwork-preparation';
const ArtworkPreparation = dynamic(
  () => import('./artwork-preparation').then((module) => module.ArtworkPreparation),
  { ssr: false },
);

import { ArtworkEditor } from './artwork-editor';
import { useConfirm } from './confirm-dialog';

export function ArtworkPage({
  initial,
  initialSelected = null,
  initialState = 'active',
}: {
  initial: StoredArtwork[];
  initialSelected?: StoredArtwork | null;
  initialState?: 'active' | 'archived';
}) {
  const hydrated = useHydrated();
  const [artworks, setArtworks] = useState(initial);
  const [selected, setSelected] = useState<StoredArtwork | null>(initialSelected);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [preparation, setPreparation] = useState<PreparationEntry | null>(null);
  const replacement = useRef<StoredArtwork | null>(null);
  const [libraryState, setLibraryState] = useState(initialState);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { confirm, prompt, dialog } = useConfirm();

  const reload = useCallback(
    async (nextState = libraryState) => {
      const body = await artworkRequest<{ artworks: StoredArtwork[] }>(
        `/api/artworks?state=${nextState}`,
      );
      setArtworks(body.artworks);
      const current = selectedRef.current;
      if (current) {
        const refreshed =
          body.artworks.find((item) => item.ref.artworkId === current.ref.artworkId) ??
          (await artworkRequest<StoredArtwork>(`/api/artworks/${current.ref.artworkId}`));
        setSelected((entry) =>
          entry?.ref.artworkId === current.ref.artworkId ? refreshed : entry,
        );
      }
    },
    [libraryState],
  );

  useEffect(() => {
    const refresh = () =>
      void reload().catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'The library could not reload.'),
      );
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [reload]);

  const archiveArtwork = async (artwork: StoredArtwork, archived: boolean) => {
    setError(null);
    setBusy(true);
    try {
      if (archived) {
        const { usageCount } = await artworkRequest<{ usageCount: number }>(
          `/api/artworks/${artwork.ref.artworkId}/archive`,
        );
        if (
          !(await confirm({
            title: `Archive “${artwork.name}”?`,
            body: ['Hide this artwork from the active library and new designs.'],
            consequences: [
              `${usageCount} saved design${usageCount === 1 ? '' : 's'} will become view-only for everyone in your organisation.`,
              'You can restore the artwork later. No files will be deleted.',
            ],
            confirmLabel: 'Archive artwork',
          }))
        )
          return;
      }
      await artworkRequest(`/api/artworks/${artwork.ref.artworkId}/archive`, {
        method: archived ? 'POST' : 'DELETE',
      });
      setMessage(
        archived
          ? 'Artwork archived. Existing designs are now view-only.'
          : 'Artwork restored. Designs with no remaining archived artwork can be edited again.',
      );
      if (archived) setSelected(null);
      if (!archived) setLibraryState('active');
      await reload(archived ? libraryState : 'active');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The archive could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const input = await readPreparationFile(file);
      const target = replacement.current;
      replacement.current = null;
      setPreparation({
        ...input,
        ...(target ? { artworkId: target.ref.artworkId, versionId: target.ref.versionId } : {}),
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (artwork: StoredArtwork) => {
    const name = await prompt({
      title: 'Rename this artwork',
      input: { label: 'Name', defaultValue: artwork.name },
      confirmLabel: 'Rename',
    });
    if (!name) return;
    setError(null);
    setBusy(true);
    try {
      await artworkRequest(`/api/artworks/${artwork.ref.artworkId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The rename failed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (artwork: StoredArtwork) => {
    if (
      !(await confirm({
        title: `Delete ${artwork.name}?`,
        consequences: [
          'It leaves your organisation’s library.',
          'Artwork used by a saved design cannot be deleted.',
        ],
        confirmLabel: 'Delete artwork',
        tone: 'danger',
      }))
    )
      return;
    setError(null);
    setBusy(true);
    try {
      await artworkRequest(`/api/artworks/${artwork.ref.artworkId}`, { method: 'DELETE' });
      setSelected(null);
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The deletion failed.');
    } finally {
      setBusy(false);
    }
  };

  const visible = artworks
    .filter((artwork) => artwork.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );

  if (preparation)
    return (
      <ArtworkPreparation
        entry={preparation}
        persist
        onCancel={() => setPreparation(null)}
        onSaved={(artwork) => {
          setPreparation(null);
          setSelected(preparation.artworkId ? artwork : null);
          void reload().catch((error: unknown) =>
            setError(error instanceof Error ? error.message : 'The library could not reload.'),
          );
        }}
      />
    );

  return (
    <main
      className={`artwork-page${selected ? ' artwork-page-expanded' : ''}`}
      data-testid="artwork-page"
      data-hydrated={hydrated}
    >
      {dialog}
      <input
        ref={fileInput}
        hidden
        type="file"
        accept=".svg,image/svg+xml"
        data-testid="gallery-upload-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />

      <header className="artwork-page-head">
        <div>
          <h1>Artwork</h1>
          <p>View and edit your organisation’s SVG files.</p>
        </div>
        {!selected && (
          <>
            <button
              type="button"
              className="primary artwork-upload"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              data-testid="gallery-upload"
            >
              {busy ? <LoadingSpinner compact /> : <Upload size={18} />}
              {busy ? 'Processing…' : 'Upload SVG'}
            </button>
          </>
        )}
      </header>
      {error && (
        <p className="issue error" data-testid="artwork-page-error">
          {error}
        </p>
      )}
      {message && (
        <p className="issue ok" data-testid="artwork-message">
          {message}
        </p>
      )}
      {selected ? (
        <ArtworkEditor
          key={`${selected.ref.versionId}-${selected.name}`}
          artwork={selected}
          others={artworks.filter((artwork) => artwork.ref.artworkId !== selected.ref.artworkId)}
          busy={busy}
          onChoose={(artwork) => {
            setError(null);
            setSelected(artwork);
          }}
          onClose={() => {
            setError(null);
            setSelected(null);
          }}
          onDelete={() => remove(selected)}
          onArchive={() => archiveArtwork(selected, !selected.archivedAt)}
          onRefresh={() => void reload()}
          onEditSelection={() => {
            if (selected.selectionEditable)
              setPreparation({
                artworkId: selected.ref.artworkId,
                versionId: selected.ref.versionId,
              });
            else {
              replacement.current = selected;
              fileInput.current?.click();
            }
          }}
          onSaved={(artwork) => {
            setArtworks((previous) =>
              previous.map((entry) =>
                entry.ref.artworkId === artwork.ref.artworkId ? artwork : entry,
              ),
            );
            setSelected(artwork);
          }}
        />
      ) : (
        <>
          <div className="artwork-filters">
            <label className="artwork-search">
              <Search size={18} />
              <input
                placeholder="Search artwork…"
                aria-label="Search artwork"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                data-testid="artwork-search"
              />
            </label>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              aria-label="Sort artwork"
            >
              <option value="newest">Newest first</option>
              <option value="name">Name A–Z</option>
            </select>
            <div className="segmented artwork-state-filter" aria-label="Artwork status">
              {(['active', 'archived'] as const).map((state) => (
                <button
                  key={state}
                  type="button"
                  className={libraryState === state ? 'active' : ''}
                  aria-pressed={libraryState === state}
                  disabled={busy}
                  onClick={() => {
                    setLibraryState(state);
                    setMessage(null);
                  }}
                >
                  {state === 'active' ? 'Active' : 'Archived'}
                </button>
              ))}
            </div>
          </div>
          {libraryState === 'archived' && (
            <p className="archive-library-note">
              Archived artwork is hidden from new designs. Existing designs remain view-only.
            </p>
          )}
          {visible.length === 0 && (
            <p className="auth-sub" data-testid="artwork-empty">
              {artworks.length
                ? 'No artwork matches your search.'
                : libraryState === 'archived'
                  ? 'No archived artwork.'
                  : 'No artwork yet. Upload an SVG to start your library.'}
            </p>
          )}
          <ul className="artwork-gallery" data-testid="artwork-gallery">
            {visible.map((artwork) => (
              <li
                key={artwork.ref.artworkId}
                className="artwork-tile"
                data-testid={`artwork-tile-${artwork.ref.artworkId}`}
              >
                <button
                  type="button"
                  className="artwork-tile-open"
                  onClick={() => setSelected(artwork)}
                  disabled={busy}
                >
                  <span className="artwork-tile-preview">
                    <img src={artwork.sourceUrl} alt="" />
                  </span>
                  <span className="artwork-tile-name">{artwork.name}</span>
                  {artwork.archivedAt && <span className="archive-status">Archived</span>}
                  <span className="artwork-tile-meta">
                    {artwork.naturalSizeMm.w.toFixed(1)} × {artwork.naturalSizeMm.h.toFixed(1)} mm
                  </span>
                  <span className="artwork-tile-meta">
                    {artwork.archivedAt ? 'Archived' : 'Uploaded'}{' '}
                    {new Date(artwork.archivedAt ?? artwork.createdAt).toLocaleDateString()}
                  </span>
                </button>
                <div className="artwork-tile-actions">
                  {artwork.archivedAt ? (
                    <button
                      type="button"
                      className="artwork-restore"
                      disabled={busy}
                      onClick={() => void archiveArtwork(artwork, false)}
                    >
                      Restore artwork
                    </button>
                  ) : (
                    <button type="button" onClick={() => void rename(artwork)} disabled={busy}>
                      Rename
                    </button>
                  )}
                  <details className="artwork-tile-menu">
                    <summary aria-label={`Actions for ${artwork.name}`}>
                      <MoreHorizontal size={20} />
                    </summary>
                    <div className="artwork-tile-menu-panel">
                      {!artwork.archivedAt && (
                        <button
                          type="button"
                          onClick={() => void archiveArtwork(artwork, true)}
                          disabled={busy}
                        >
                          Archive artwork
                        </button>
                      )}
                      <button type="button" onClick={() => void remove(artwork)} disabled={busy}>
                        Delete artwork
                      </button>
                    </div>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
