'use client';

import { LoadingSpinner } from '@/components/loading-spinner';

import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  ArrowLeft,
  FlipHorizontal2,
  FlipVertical2,
  LockKeyhole,
  UnlockKeyhole,
} from 'lucide-react';
import { transformArtworkSvg } from '@pr/raster';
import { ArtworkEdit } from '@pr/design-schema';
import { normalizeSvg, sanitizeSvg, type NormalizedArtwork } from '@pr/svg';
import type { StoredArtwork } from '@/lib/editor-data';
import {
  artworkEditChanged,
  artworkEditReducer,
  initialArtworkEdit,
} from '@/lib/artwork-edit-state';
import { artworkRequest, ArtworkRequestError } from '@/lib/artwork-api';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { useConfirm } from './confirm-dialog';
import { ArtworkViewer } from './artwork-viewer';
import { ArchiveBanner } from './archive-banner';

export function ArtworkEditor({
  artwork,
  others,
  busy,
  onChoose,
  onClose,
  onSaved,
  onDelete,
  onEditSelection,
  onArchive,
  onRefresh,
}: {
  artwork: StoredArtwork;
  others: StoredArtwork[];
  busy: boolean;
  onChoose: (artwork: StoredArtwork) => void;
  onClose: () => void;
  onSaved: (artwork: StoredArtwork) => void;
  onDelete: () => Promise<void>;
  onEditSelection: () => void;
  onArchive: () => Promise<void>;
  onRefresh: () => void;
}) {
  const initial = useMemo(() => initialArtworkEdit(artwork), [artwork]);
  const [history, dispatch] = useReducer(artworkEditReducer, {
    past: [],
    present: initial,
    future: [],
  });
  const edit = history.present;
  const [normalized, setNormalized] = useState<NormalizedArtwork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [aspectLocked, setAspectLocked] = useState(true);
  const { confirm, dialog } = useConfirm();
  const dirty = artworkEditChanged(edit, initial);
  const leaveDialog = useUnsavedGuard(dirty || saving, 'Your artwork changes have not been saved.');
  const valid = ArtworkEdit.safeParse(edit).success;
  const navigationDisabled = busy || saving;
  const [archiveDiscovered, setArchiveDiscovered] = useState(false);
  const readOnly = Boolean(artwork.archivedAt) || archiveDiscovered;
  const disabled = navigationDisabled || readOnly;
  useEffect(() => setArchiveDiscovered(false), [artwork.archivedAt]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(artwork.sourceUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('The SVG could not be loaded. Reopen the artwork to try again.');
        const source = await response.text();
        if (!controller.signal.aborted) setNormalized(normalizeSvg(sanitizeSvg(source).root));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'The SVG could not be loaded.');
      });
    return () => controller.abort();
  }, [artwork.sourceUrl]);

  const preview = useMemo(() => {
    if (!normalized || !valid) return null;
    const svg = transformArtworkSvg(normalized, edit);
    const output = normalizeSvg(sanitizeSvg(svg).root);
    return {
      src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      size: output.naturalSizeMm,
    };
  }, [normalized, edit, valid]);

  const leave = async (next: () => void) => {
    if (navigationDisabled) return;
    if (
      dirty &&
      !(await confirm({
        title: 'Discard artwork changes?',
        body: ['Your changes have not been saved.'],
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      }))
    )
      return;
    next();
  };

  const save = async () => {
    if (!valid || !dirty || disabled) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await artworkRequest<StoredArtwork>(`/api/artworks/${artwork.ref.artworkId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edit),
      });
      onSaved(saved);
    } catch (error) {
      if (error instanceof ArtworkRequestError && error.code === 'archived_artwork') {
        setArchiveDiscovered(true);
        onRefresh();
      }
      setError(error instanceof Error ? error.message : 'The changes could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const resize = (axis: 'widthMm' | 'heightMm', value: number) => {
    const other = axis === 'widthMm' ? 'heightMm' : 'widthMm';
    const patch = { [axis]: value };
    if (aspectLocked && value > 0) {
      const ratio = edit[axis] > 0 ? edit[other] / edit[axis] : initial[other] / initial[axis];
      patch[other] = value * ratio;
    }
    dispatch({ type: 'edit', patch });
  };

  return (
    <>
      {dialog}
      {leaveDialog}
      <section className="artwork-workspace" data-testid="artwork-editor">
        <header className="artwork-workspace-head">
          <button
            type="button"
            className="artwork-back"
            disabled={navigationDisabled}
            onClick={() => void leave(onClose)}
          >
            <ArrowLeft size={18} />
            Back to artwork
          </button>
          <span className="artwork-workspace-name">{artwork.name}</span>
          <div className="artwork-workspace-actions">
            <button type="button" disabled={navigationDisabled} onClick={() => void leave(onClose)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!valid || !dirty || disabled || !normalized}
              onClick={() => void save()}
              data-testid="artwork-save"
            >
              <span className="loading-inline">{saving && <LoadingSpinner compact />}{saving ? 'Saving…' : 'Save changes'}</span>
            </button>
          </div>
        </header>
        {readOnly && (
          <ArchiveBanner
            title="Artwork archived — view-only."
            action={
              <button
                type="button"
                disabled={navigationDisabled}
                onClick={() => void leave(() => void onArchive())}
              >
                Restore artwork
              </button>
            }
          >
            Restore this artwork to use it again and enable editing in affected designs.
            {dirty && ' Your unsaved local changes have not been saved.'}
          </ArchiveBanner>
        )}
        {error && (
          <p className="issue error" data-testid="artwork-editor-error">
            {error}
          </p>
        )}
        <div className="artwork-workspace-body">
          {preview ? (
            <ArtworkViewer
              src={preview.src}
              widthMm={preview.size.w}
              heightMm={preview.size.h}
              editWidthMm={edit.widthMm}
              editHeightMm={edit.heightMm}
              disabled={disabled}
              onResize={(widthMm, heightMm, coalesce) =>
                dispatch({ type: 'edit', patch: { widthMm, heightMm }, coalesce })
              }
              canUndo={history.past.length > 0 && !disabled}
              canRedo={history.future.length > 0 && !disabled}
              onUndo={() => dispatch({ type: 'undo' })}
              onRedo={() => dispatch({ type: 'redo' })}
            />
          ) : (
            <div className="artwork-viewer-loading">
              {normalized
                ? 'Enter valid dimensions to preview your artwork.'
                : error
                  ? 'Preview unavailable.'
                  : <span className="loading-stack"><LoadingSpinner />Loading SVG…</span>}
            </div>
          )}
          <aside className="artwork-properties">
            <h2>Artwork properties</h2>
            <button
              type="button"
              disabled={disabled}
              data-testid="artwork-edit-selection"
              onClick={() => void leave(onEditSelection)}
            >
              {artwork.selectionEditable ? 'Edit selection' : 'Reupload original to edit selection'}
            </button>
            {!artwork.selectionEditable && (
              <p className="artwork-version-hint">
                The original file is needed because older uploads retained only normalized geometry.
                Reuploading and confirming creates a new version; existing designs keep their
                artwork.
              </p>
            )}
            {artwork.selectionEditable && (
              <a
                download
                href={`/api/artworks/${artwork.ref.artworkId}/original?versionId=${artwork.ref.versionId}`}
              >
                Download original SVG
              </a>
            )}
            <fieldset disabled={disabled}>
              <label>
                Name
                <input
                  value={edit.name}
                  maxLength={200}
                  onChange={(event) =>
                    dispatch({ type: 'edit', patch: { name: event.target.value } })
                  }
                  data-testid="artwork-edit-name"
                />
              </label>
              <div className="artwork-dimensions">
                <label>
                  Width (mm)
                  <input
                    type="number"
                    min="0.01"
                    max="1000"
                    step="any"
                    value={edit.widthMm || ''}
                    onChange={(event) => resize('widthMm', Number(event.target.value))}
                    data-testid="artwork-edit-width"
                  />
                </label>
                <button
                  type="button"
                  aria-label={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  title={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  onClick={() => setAspectLocked(!aspectLocked)}
                >
                  {aspectLocked ? <LockKeyhole size={18} /> : <UnlockKeyhole size={18} />}
                </button>
                <label>
                  Height (mm)
                  <input
                    type="number"
                    min="0.01"
                    max="1000"
                    step="any"
                    value={edit.heightMm || ''}
                    onChange={(event) => resize('heightMm', Number(event.target.value))}
                    data-testid="artwork-edit-height"
                  />
                </label>
              </div>
              <label>
                Rotate (degrees)
                <input
                  type="number"
                  min="-360"
                  max="360"
                  step="any"
                  value={edit.rotationDeg}
                  onChange={(event) =>
                    dispatch({ type: 'edit', patch: { rotationDeg: Number(event.target.value) } })
                  }
                  data-testid="artwork-edit-rotation"
                />
              </label>
              <div className="artwork-flips">
                <button
                  type="button"
                  className={edit.flipX ? 'active' : ''}
                  onClick={() => dispatch({ type: 'edit', patch: { flipX: !edit.flipX } })}
                >
                  <FlipHorizontal2 size={18} />
                  Flip horizontal
                </button>
                <button
                  type="button"
                  className={edit.flipY ? 'active' : ''}
                  onClick={() => dispatch({ type: 'edit', patch: { flipY: !edit.flipY } })}
                >
                  <FlipVertical2 size={18} />
                  Flip vertical
                </button>
              </div>
            </fieldset>
            {!valid && (
              <p className="issue error">
                Use a name, dimensions from 0.01 to 1000 mm, and a rotation from −360° to 360°.
              </p>
            )}
            <p className="artwork-version-hint">
              Saving shape changes creates a new version. Existing designs keep their artwork
              exactly as placed.
            </p>
            {artwork.report.warnings.map((warning, index) => (
              <p className="issue warning" key={index}>
                {warning.message}
              </p>
            ))}
            {!readOnly && (
              <button
                type="button"
                disabled={navigationDisabled}
                onClick={() => void leave(() => void onArchive())}
              >
                Archive artwork
              </button>
            )}
            <button type="button" disabled={navigationDisabled} onClick={() => void onDelete()}>
              Delete artwork
            </button>
          </aside>
        </div>
      </section>
      {others.length > 0 && (
        <section className="artwork-other" data-testid="artwork-filmstrip">
          <header>
            <h2>Other artwork</h2>
            <p>Select a tile to switch.</p>
          </header>
          <ul>
            {others.map((other) => (
              <li key={other.ref.artworkId}>
                <button
                  type="button"
                  disabled={navigationDisabled}
                  onClick={() => void leave(() => onChoose(other))}
                >
                  <img src={other.sourceUrl} alt="" />
                  <span>
                    <strong>{other.name}</strong>
                    <small>
                      {other.naturalSizeMm.w.toFixed(1)} × {other.naturalSizeMm.h.toFixed(1)} mm
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
