import { describe, expect, it } from 'vitest';
import type { ArtworkRepair } from '@pr/design-schema';
import type { PreparationPreview } from '@pr/svg';
import {
  currentPreparationPreview,
  initialPreparationState,
  preparationReducer,
  type PreparationState,
} from './artwork-preparation-state';

const initial = (): PreparationState =>
  initialPreparationState({
    name: 'Generic mark',
    recipe: {
      sourceDigest: 'a'.repeat(64),
      analyzerVersion: '1',
      selected: [{ objectId: 'o1', paint: 'both' }],
      repairs: [],
      acknowledged: [],
      transforms: [],
    },
  });
const close: ArtworkRepair = { kind: 'close', objectId: 'o1', subpathId: 'o1:s0' };
const preview = (state: PreparationState): PreparationPreview => ({
  svg: '<svg/>',
  sourceSvg: '<svg/>',
  objects: [],
  issues: [],
  boundsMm: { x: 0, y: 0, w: 10, h: 10 },
  keptBoundsMm: { x: 0, y: 0, w: 10, h: 10 },
  canSave: true,
  recipe: state.present.recipe,
});

describe('preparation draft and preview lifecycle', () => {
  it('enters Inspect without repairs and freezes inclusion while repairing', () => {
    const start = initial();
    const state = preparationReducer(start, { type: 'enter-repair' });
    expect(state.present).toBe(start.present);
    expect(state.pendingRepair).toBeNull();
    expect(
      preparationReducer(state, {
        type: 'edit',
        draft: { ...state.present, recipe: { ...state.present.recipe, selected: [] } },
      }),
    ).toBe(state);
  });
  it('rejects late selection and repair previews after undo changes the revision', () => {
    const start = initial();
    let state = preparationReducer(start, {
      type: 'edit',
      draft: { ...start.present, name: 'Variant' },
    });
    const obsoleteRevision = state.revision;
    state = preparationReducer(state, { type: 'undo' });
    expect(
      currentPreparationPreview(
        preparationReducer(state, {
          type: 'preview',
          revision: obsoleteRevision,
          result: preview(state),
        }),
      ),
    ).toBeNull();
    state = preparationReducer(state, { type: 'enter-repair' });
    state = preparationReducer(state, { type: 'choose-repair', operation: close });
    state = preparationReducer(state, {
      type: 'repair-preview',
      revision: obsoleteRevision,
      operation: close,
      result: preview(state),
    });
    expect(state.pendingRepair?.result).toBeNull();
    expect(preparationReducer(state, { type: 'apply-repair' })).toBe(state);
  });
  it('invalidates an earlier closure preview when the user chooses a different operation', () => {
    let state = preparationReducer(initial(), { type: 'enter-repair' });
    state = preparationReducer(state, { type: 'choose-repair', operation: close });
    const width: ArtworkRepair = { kind: 'stroke-width', objectId: 'o1', widthMm: 1 };
    state = preparationReducer(state, { type: 'choose-repair', operation: width });
    state = preparationReducer(state, {
      type: 'repair-preview',
      revision: state.revision,
      operation: close,
      result: preview(state),
    });
    expect(state.pendingRepair?.result).toBeNull();
    expect(preparationReducer(state, { type: 'apply-repair' })).toBe(state);
  });
  it('requires preview, Apply, and explicit discard before leaving with a pending operation', () => {
    let state = preparationReducer(initial(), { type: 'enter-repair' });
    state = preparationReducer(state, { type: 'choose-repair', operation: close });
    expect(preparationReducer(state, { type: 'leave-repair' })).toBe(state);
    expect(preparationReducer(state, { type: 'apply-repair' })).toBe(state);
    state = preparationReducer(state, {
      type: 'repair-preview',
      revision: state.revision,
      operation: close,
      result: preview(state),
    });
    expect(state.present.recipe.repairs).toEqual([]);
    state = preparationReducer(state, { type: 'apply-repair' });
    expect(state.present.recipe.repairs).toEqual([close]);
    expect(state.mode).toBe('repair');
    expect(state.pendingRepair).toBeNull();
    state = preparationReducer(state, { type: 'undo' });
    expect(state.present.recipe.repairs).toEqual([]);
    state = preparationReducer(state, { type: 'redo' });
    expect(state.present.recipe.repairs).toEqual([close]);
    state = preparationReducer(state, { type: 'choose-repair', operation: close });
    state = preparationReducer(state, { type: 'discard-preview' });
    state = preparationReducer(state, { type: 'leave-repair' });
    expect(state.mode).toBe('select');
    expect(state.present.recipe.repairs).toEqual([close]);
  });
  it('keeps excluded repairs in undo history and blocks invalid geometry', () => {
    let state = preparationReducer(initial(), { type: 'enter-repair' });
    state = preparationReducer(state, { type: 'choose-repair', operation: close });
    state = preparationReducer(state, {
      type: 'repair-preview',
      revision: state.revision,
      operation: close,
      result: {
        ...preview(state),
        issues: [
          {
            id: 'invalid',
            code: 'invalid_geometry',
            severity: 'error',
            message: 'Invalid geometry',
          },
        ],
      },
    });
    expect(preparationReducer(state, { type: 'apply-repair' })).toBe(state);
    state = preparationReducer(state, {
      type: 'repair-preview',
      revision: state.revision,
      operation: close,
      result: preview(state),
    });
    state = preparationReducer(state, { type: 'apply-repair' });
    state = preparationReducer(state, { type: 'leave-repair' });
    state = preparationReducer(state, {
      type: 'edit',
      draft: { ...state.present, recipe: { ...state.present.recipe, selected: [] } },
    });
    expect(state.present.recipe.repairs).toEqual([close]);
    state = preparationReducer(state, { type: 'undo' });
    expect(state.present.recipe.selected).toHaveLength(1);
    expect(state.present.recipe.repairs).toEqual([close]);
  });
});
