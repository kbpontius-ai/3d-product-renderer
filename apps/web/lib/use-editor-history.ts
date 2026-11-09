'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorState } from './design-state.js';
import {
  amendHistory,
  canRedo,
  canUndo,
  initialHistory,
  pushHistory,
  redo,
  undo,
  type PushOptions,
} from './history.js';

/**
 * The editor's working state, with undo (F-EDIT-05).
 *
 * Every change goes through `apply` with a label saying what the user did; the label is what
 * decides whether a change joins the previous step or starts a new one. `amend` exists for the
 * corrections the editor makes on the user's behalf — those are not steps to undo.
 */

export interface EditorHistory {
  state: EditorState;
  apply: (
    label: string,
    mutate: (state: EditorState) => EditorState,
    options?: PushOptions,
  ) => void;
  amend: (mutate: (state: EditorState) => EditorState) => void;
  undo: () => void;
  redo: () => void;
  hasEdits: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export function useEditorHistory(initial: EditorState, disabled = false): EditorHistory {
  // A stable amend callback prevents archive/restore from triggering the editor’s artwork refit effect.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [history, setHistory] = useState(() => initialHistory(initial, Date.now()));

  const apply = useCallback(
    (label: string, mutate: (state: EditorState) => EditorState, options?: PushOptions) => {
      // Read the clock here rather than inside the updater. `apply` runs synchronously from the
      // event, while the updater runs whenever React gets to it — so a timestamp taken in there
      // measures how busy the main thread was, not when the user did anything. Two pointer moves
      // 16 ms apart could be stamped a second apart on a loaded machine, which split a single drag
      // into two history entries and made undo take back only the last part of it.
      //
      // It also keeps the updater pure, which is what React expects of one.
      if (disabledRef.current) return;
      const at = Date.now();
      setHistory((current) =>
        pushHistory(current, mutate(current.present.state), label, at, options),
      );
    },
    [],
  );

  const amend = useCallback((mutate: (state: EditorState) => EditorState) => {
    if (disabledRef.current) return;
    setHistory((current) => amendHistory(current, mutate(current.present.state)));
  }, []);

  const stepBack = useCallback(() => {
    if (!disabledRef.current) setHistory(undo);
  }, []);
  const stepForward = useCallback(() => {
    if (!disabledRef.current) setHistory(redo);
  }, []);

  // The shortcuts everyone already has in their fingers.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;

      const target = event.target as HTMLElement | null;
      // Typing in a field has its own undo; do not take it over.
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

      event.preventDefault();
      if (event.shiftKey) stepForward();
      else stepBack();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stepBack, stepForward]);

  return useMemo(
    () => ({
      state: history.present.state,
      apply,
      amend,
      undo: stepBack,
      redo: stepForward,
      hasEdits: history.past.length > 0,
      canUndo: !disabled && canUndo(history),
      canRedo: !disabled && canRedo(history),
    }),
    [amend, apply, history, stepBack, stepForward, disabled],
  );
}
