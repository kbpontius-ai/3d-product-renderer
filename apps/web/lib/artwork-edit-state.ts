import type { ArtworkEdit } from '@pr/design-schema';
import type { StoredArtwork } from './editor-data';

export const initialArtworkEdit = (artwork: StoredArtwork): ArtworkEdit => ({
  versionId: artwork.ref.versionId,
  name: artwork.name,
  widthMm: artwork.naturalSizeMm.w,
  heightMm: artwork.naturalSizeMm.h,
  rotationDeg: 0,
  flipX: false,
  flipY: false,
});

export const artworkEditChanged = (a: ArtworkEdit, b: ArtworkEdit): boolean =>
  a.name !== b.name ||
  a.widthMm !== b.widthMm ||
  a.heightMm !== b.heightMm ||
  a.rotationDeg !== b.rotationDeg ||
  a.flipX !== b.flipX ||
  a.flipY !== b.flipY;

export interface ArtworkEditHistory {
  past: ArtworkEdit[];
  present: ArtworkEdit;
  future: ArtworkEdit[];
}

export function artworkEditReducer(
  history: ArtworkEditHistory,
  action:
    | { type: 'edit'; patch: Partial<ArtworkEdit>; coalesce?: boolean }
    | { type: 'undo' | 'redo' },
): ArtworkEditHistory {
  if (action.type === 'edit') {
    const next = { ...history.present, ...action.patch };
    if (!artworkEditChanged(next, history.present)) return history;
    return {
      past: action.coalesce ? history.past : [...history.past, history.present],
      present: next,
      future: [],
    };
  }
  if (action.type === 'undo') {
    const previous = history.past.at(-1);
    return previous
      ? {
          past: history.past.slice(0, -1),
          present: previous,
          future: [history.present, ...history.future],
        }
      : history;
  }
  const next = history.future[0];
  return next
    ? {
        past: [...history.past, history.present],
        present: next,
        future: history.future.slice(1),
      }
    : history;
}
