import type { ArtworkPreparationRecipe, ArtworkRepair } from '@pr/design-schema';
import type { PreparationPreview } from '@pr/svg';

export interface PreparationDraft {
  name: string;
  recipe: ArtworkPreparationRecipe;
}

export interface PreparationState {
  past: PreparationDraft[];
  present: PreparationDraft;
  future: PreparationDraft[];
  revision: number;
  mode: 'select' | 'repair';
  preview: { revision: number; result: PreparationPreview } | null;
  pendingRepair: {
    operation: ArtworkRepair;
    revision: number;
    result: PreparationPreview | null;
  } | null;
}

export type PreparationAction =
  | { type: 'edit'; draft: PreparationDraft }
  | { type: 'undo' | 'redo' }
  | { type: 'enter-repair' | 'leave-repair' }
  | { type: 'preview'; revision: number; result: PreparationPreview }
  | { type: 'choose-repair'; operation: ArtworkRepair }
  | {
      type: 'repair-preview';
      operation: ArtworkRepair;
      revision: number;
      result: PreparationPreview;
    }
  | { type: 'apply-repair' | 'discard-preview' };

export function initialPreparationState(draft: PreparationDraft): PreparationState {
  return {
    past: [],
    present: draft,
    future: [],
    revision: 0,
    mode: 'select',
    preview: null,
    pendingRepair: null,
  };
}

function editDraft(state: PreparationState, draft: PreparationDraft): PreparationState {
  if (JSON.stringify(draft) === JSON.stringify(state.present)) return state;
  return {
    ...state,
    past: [...state.past, state.present],
    present: draft,
    future: [],
    revision: state.revision + 1,
    preview: null,
    pendingRepair: null,
  };
}

export function preparationReducer(
  state: PreparationState,
  action: PreparationAction,
): PreparationState {
  switch (action.type) {
    case 'edit':
      return state.mode === 'select' ? editDraft(state, action.draft) : state;
    case 'undo': {
      const previous = state.past.at(-1);
      return previous
        ? {
            ...state,
            past: state.past.slice(0, -1),
            present: previous,
            future: [state.present, ...state.future],
            revision: state.revision + 1,
            preview: null,
            pendingRepair: null,
          }
        : state;
    }
    case 'redo': {
      const next = state.future[0];
      return next
        ? {
            ...state,
            past: [...state.past, state.present],
            present: next,
            future: state.future.slice(1),
            revision: state.revision + 1,
            preview: null,
            pendingRepair: null,
          }
        : state;
    }
    case 'enter-repair':
      return { ...state, mode: 'repair', pendingRepair: null };
    case 'leave-repair':
      return state.pendingRepair ? state : { ...state, mode: 'select' };
    case 'preview':
      return action.revision === state.revision
        ? { ...state, preview: { revision: action.revision, result: action.result } }
        : state;
    case 'choose-repair':
      return state.mode === 'repair'
        ? {
            ...state,
            pendingRepair: { operation: action.operation, revision: state.revision, result: null },
          }
        : state;
    case 'repair-preview':
      return state.pendingRepair &&
        action.revision === state.revision &&
        JSON.stringify(action.operation) === JSON.stringify(state.pendingRepair.operation)
        ? { ...state, pendingRepair: { ...state.pendingRepair, result: action.result } }
        : state;
    case 'apply-repair': {
      const pending = state.pendingRepair;
      if (
        !pending?.result ||
        pending.revision !== state.revision ||
        pending.result.issues.some((issue) => issue.severity === 'error')
      )
        return state;
      return editDraft(state, {
        ...state.present,
        recipe: {
          ...state.present.recipe,
          repairs: [...state.present.recipe.repairs, pending.operation],
        },
      });
    }
    case 'discard-preview':
      return { ...state, pendingRepair: null };
  }
}

export function currentPreparationPreview(state: PreparationState): PreparationPreview | null {
  return state.preview?.revision === state.revision ? state.preview.result : null;
}
