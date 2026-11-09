'use client';

import type { ArchivedArtwork } from '@pr/artworks';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignDocument } from '@pr/design-schema';
import { documentsDiffer } from './design-state.js';

/**
 * Autosave for the editor (build order G2).
 *
 * The rules are: never save a design the validation strip is rejecting, never save what is already
 * stored, and never resolve a conflict by guessing. A save that loses the optimistic lock stops the
 * loop and asks — silently overwriting the other tab is the one outcome nobody can undo.
 */

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'blocked' | 'conflict' | 'error';

export interface DesignBinding {
  id: string;
  archivedArtworks?: ArchivedArtwork[];
  name: string;
  version: number;
  document: DesignDocument;
}

export interface DesignSave {
  status: SaveStatus;
  version: number;
  /** Wait for pending saves; false means validation, a conflict, or a request prevented saving. */
  saveNow: () => Promise<boolean>;
}

const DEBOUNCE_MS = 900;

export function useDesignSave(
  binding: DesignBinding | undefined,
  document: DesignDocument | null,
  options: { blocked: boolean; onArchived?: (artworks: ArchivedArtwork[]) => void },
): DesignSave {
  const onArchived = options.onArchived;
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [version, setVersion] = useState(binding?.version ?? 0);

  // Refs, not state: the timer callback must see the latest values without being re-created, and
  // re-creating it would restart the debounce on every keystroke.
  const savedRef = useRef<DesignDocument | null>(binding?.document ?? null);
  const pendingRef = useRef<DesignDocument | null>(null);
  const versionRef = useRef(binding?.version ?? 0);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const conflictRef = useRef(false);
  const blockedRef = useRef(options.blocked);
  blockedRef.current = options.blocked;

  /**
   * Writes every pending version, in order, until the working copy and the server agree.
   *
   * The loop is the point: edits made while a request is in flight are picked up by the next turn
   * rather than waiting for a debounce that will never be scheduled, so the last thing a user did
   * before closing the tab is the thing that gets stored.
   */
  const flush = useCallback((): Promise<boolean> => {
    if (inFlightRef.current) return inFlightRef.current;
    if (!binding || conflictRef.current) return Promise.resolve(false);

    // Assign the promise before the loop starts, including the already-saved case.
    const request = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const next = pendingRef.current;
          if (!next || !documentsDiffer(next, savedRef.current ?? next)) break;
          if (blockedRef.current) {
            setStatus('blocked');
            return false;
          }

          setStatus('saving');
          const response = await fetch(`/api/designs/${binding.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ document: next, expectedVersion: versionRef.current }),
          });

          if (response.status === 409) {
            const body = (await response.json()) as {
              error?: { code?: string; archivedArtworks?: ArchivedArtwork[] };
            };
            if (body.error?.code === 'archived_artwork') {
              blockedRef.current = true;
              onArchived?.(body.error.archivedArtworks ?? []);
              setStatus('blocked');
              return false;
            }
            conflictRef.current = true;
            setStatus('conflict');
            return false;
          }
          if (!response.ok) {
            setStatus('error');
            return false;
          }

          const result = (await response.json()) as { version: number };
          versionRef.current = result.version;
          savedRef.current = next;
          setVersion(result.version);
        }
        setStatus('saved');
        return true;
      } catch {
        setStatus('error');
        return false;
      } finally {
        inFlightRef.current = null;
      }
    });
    inFlightRef.current = request;
    return request;
  }, [binding, onArchived]);

  useEffect(() => {
    if (!binding || !document) return;
    pendingRef.current = document;

    if (conflictRef.current) return;
    if (!documentsDiffer(document, savedRef.current ?? document)) {
      if (!inFlightRef.current) setStatus('saved');
      return;
    }
    if (options.blocked) {
      setStatus('blocked');
      return;
    }

    setStatus((s) => (s === 'saving' ? s : 'dirty'));
    const timer = setTimeout(() => void flush(), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [binding, document, flush, options.blocked]);

  const saveNow = useCallback(async () => {
    if (options.blocked) {
      setStatus('blocked');
      return false;
    }
    return flush();
  }, [flush, options.blocked]);

  return { status, version, saveNow };
}

export const SAVE_LABELS: Record<SaveStatus, string> = {
  idle: 'Not saved yet',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'All changes saved',
  blocked: 'Not saved — fix the problems below',
  conflict: 'Edited in another tab — reload to continue',
  error: 'Could not save — retrying on the next change',
};
