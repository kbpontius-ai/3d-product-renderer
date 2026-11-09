import { expect, it } from 'vitest';
import {
  artworkEditChanged,
  artworkEditReducer,
  type ArtworkEditHistory,
} from './artwork-edit-state';

it('undoes and redoes edits, clears the redo branch, and recognises a clean state', () => {
  const initial = {
    versionId: 'v1',
    name: 'Logo',
    widthMm: 24,
    heightMm: 18,
    rotationDeg: 0,
    flipX: false,
    flipY: false,
  };
  const history: ArtworkEditHistory = { past: [], present: initial, future: [] };
  const edited = artworkEditReducer(history, {
    type: 'edit',
    patch: { widthMm: 48, heightMm: 36 },
  });
  expect(artworkEditChanged(edited.present, initial)).toBe(true);
  const undone = artworkEditReducer(edited, { type: 'undo' });
  expect(artworkEditChanged(undone.present, initial)).toBe(false);
  expect(artworkEditReducer(undone, { type: 'redo' }).present).toEqual(edited.present);
  const forked = artworkEditReducer(undone, { type: 'edit', patch: { flipY: true } });
  expect(forked.future).toEqual([]);
  expect(artworkEditReducer(forked, { type: 'redo' })).toBe(forked);
  expect(artworkEditReducer(history, { type: 'edit', patch: { name: 'Logo' } })).toBe(history);
  const dragged = artworkEditReducer(edited, {
    type: 'edit',
    patch: { widthMm: 72, heightMm: 54 },
    coalesce: true,
  });
  expect(artworkEditReducer(dragged, { type: 'undo' }).present).toEqual(initial);
  const nextGesture = artworkEditReducer(dragged, {
    type: 'edit',
    patch: { widthMm: 96, heightMm: 72 },
  });
  expect(artworkEditReducer(nextGesture, { type: 'undo' }).present).toEqual(dragged.present);
});
