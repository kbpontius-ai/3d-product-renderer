/**
 * Undo/redo for the editor (F-EDIT-05, build order G3).
 *
 * A command stack over whole editor states rather than diffs: an editor state is small, and storing
 * it whole means undo cannot drift out of sync with the thing it is undoing.
 *
 * Coalescing is what makes it feel right. Dragging a logo across a face is one action to a person
 * and a hundred to a mouse, so consecutive edits of the same kind, close together in time, collapse
 * into one entry — while switching face, or changing the finish, always stands alone.
 */

export interface HistoryEntry<T> {
  state: T;
  /** What the user did. Same label plus closeness in time means one action, not many. */
  label: string;
  /** When the action began. What undo reports, and what a label in the UI would show. */
  at: number;
  /**
   * When it last changed.
   *
   * Separate from `at` because the coalescing window is a *gap* between events, not a cap on how
   * long an action may take. Measuring from the start instead made every drag longer than
   * `COALESCE_MS` split in two, so undoing a slow drag took back only the last part of it.
   */
  updatedAt: number;
  /**
   * Set when the action that made this entry has finished.
   *
   * A closed entry never merges, however quickly the next edit follows. This is what lets a caller
   * that knows where its gesture ended — a pointer release, say — say so, instead of leaving the
   * clock to guess.
   */
  closed?: boolean;
}

export interface History<T> {
  past: HistoryEntry<T>[];
  present: HistoryEntry<T>;
  future: HistoryEntry<T>[];
}

/**
 * How long a gap may be before the next edit is a new action.
 *
 * Long enough to cover a pause mid-drag, short enough that two deliberate nudges stay separate. It
 * bounds the silence between events, never the duration of the drag: somebody easing a logo across
 * a face for five seconds did one thing, and one press should take it back.
 */
export const COALESCE_MS = 700;

/** Bounded so a long session cannot grow without limit; older steps fall off the back. */
export const MAX_ENTRIES = 100;

export function initialHistory<T>(state: T, at = 0): History<T> {
  return { past: [], present: { state, label: 'open', at, updatedAt: at }, future: [] };
}

export interface PushOptions {
  /** Never merge with the previous entry, however quickly it followed. */
  discrete?: boolean;
  /**
   * Part of a gesture already in progress.
   *
   * Merges with the entry in progress however long the gesture has been running. A caller that
   * knows a drag is still going — because it has the pointer captured — is a better authority on
   * that than any timeout, and `COALESCE_MS` stays for the callers that have nothing to say.
   */
  continues?: boolean;
  /**
   * The end of a gesture.
   *
   * Merges like `continues`, then closes the entry so the next edit starts a new one. One press of
   * undo then takes back the whole gesture, whether it took a tenth of a second or ten.
   */
  ends?: boolean;
  coalesceMs?: number;
}

export function pushHistory<T>(
  history: History<T>,
  state: T,
  label: string,
  at: number,
  options: PushOptions = {},
): History<T> {
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const gesture = Boolean(options.continues || options.ends);
  const sameAction = history.present.label === label && !history.present.closed;
  const mergeable =
    !options.discrete &&
    sameAction &&
    // A caller inside a gesture knows it is inside one; everyone else is judged on the clock.
    (gesture || at - history.present.updatedAt < coalesceMs);

  if (mergeable) {
    // The same action, still in progress: replace where it ended up, keep when it started, and
    // move the window along so the next event is measured from this one.
    return {
      past: history.past,
      present: {
        state,
        label,
        at: history.present.at,
        updatedAt: at,
        ...(options.ends ? { closed: true } : {}),
      },
      future: [],
    };
  }

  const past = [...history.past, history.present].slice(-MAX_ENTRIES);
  return { past, present: { state, label, at, updatedAt: at, ...(options.ends ? { closed: true } : {}) }, future: [] };
}

export const canUndo = <T>(history: History<T>): boolean => history.past.length > 0;
export const canRedo = <T>(history: History<T>): boolean => history.future.length > 0;

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (!previous) return history;

  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (!next) return history;

  return { past: [...history.past, history.present], present: next, future: rest };
}

/**
 * Replaces the state without recording a step.
 *
 * For corrections the editor makes on the user's behalf — clamping a depth to a new face's limit,
 * say. Undoing should return to what the user last chose, not to a state they never saw.
 */
export function amendHistory<T>(history: History<T>, state: T): History<T> {
  return { ...history, present: { ...history.present, state } };
}
