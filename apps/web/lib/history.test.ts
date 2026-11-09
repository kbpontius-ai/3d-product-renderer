import { describe, expect, it } from 'vitest';
import {
  amendHistory,
  canRedo,
  canUndo,
  COALESCE_MS,
  initialHistory,
  MAX_ENTRIES,
  pushHistory,
  redo,
  undo,
} from './history.js';

/**
 * What matters about undo is not that it moves a pointer, but that one press undoes one *action* —
 * so most of this is about which edits merge and which do not.
 */

const start = () => initialHistory({ x: 0 }, 0);
const at = (history: ReturnType<typeof start>) => history.present.state.x;

describe('pushHistory', () => {
  it('records an edit', () => {
    const history = pushHistory(start(), { x: 1 }, 'move', 100);

    expect(at(history)).toBe(1);
    expect(canUndo(history)).toBe(true);
    expect(history.past).toHaveLength(1);
  });

  it('merges a continuing drag into one step', () => {
    let history = start();
    for (let i = 1; i <= 20; i++) history = pushHistory(history, { x: i }, 'move', i * 16);

    // Twenty pointer moves, one thing the user did.
    expect(history.past).toHaveLength(1);
    expect(at(history)).toBe(20);
    expect(at(undo(history))).toBe(0);
  });

  it('merges a drag that takes longer than the coalescing window', () => {
    // The window bounds the gap between events, not how long the action may take. Measuring from
    // the start instead split every slow drag in two, and undo took back only the last part of it —
    // which is what a person notices as "undo does not work" rather than as a subtle bug.
    let history = start();
    const step = COALESCE_MS / 4;
    for (let i = 1; i <= 12; i++) history = pushHistory(history, { x: i }, 'move', i * step);

    expect(history.past).toHaveLength(1);
    expect(at(history)).toBe(12);
    expect(at(undo(history))).toBe(0);
  });

  it('keeps a second drag separate once the first has settled', () => {
    let history = pushHistory(start(), { x: 5 }, 'move', 0);
    history = pushHistory(history, { x: 9 }, 'move', COALESCE_MS + 1);

    expect(history.past).toHaveLength(2);
    expect(at(undo(history))).toBe(5);
  });

  it('measures the gap from the last event, not from the first', () => {
    // A long drag followed by a real pause: the pause ends the action even though every event
    // inside the drag was close to the one before it.
    let history = pushHistory(start(), { x: 1 }, 'move', 0);
    history = pushHistory(history, { x: 2 }, 'move', COALESCE_MS - 1);
    history = pushHistory(history, { x: 3 }, 'move', 2 * COALESCE_MS - 2);
    expect(history.past).toHaveLength(1);

    history = pushHistory(history, { x: 4 }, 'move', 3 * COALESCE_MS);
    expect(history.past).toHaveLength(2);
    expect(at(undo(history))).toBe(3);
  });

  it('merges a gesture the caller says is still running, however long it takes', () => {
    // The canvas knows the pointer is still down. That beats any timeout, and a drag that pauses
    // for a thought mid-way is still one thing the person did.
    let history = start();
    for (let i = 1; i <= 5; i++) {
      history = pushHistory(history, { x: i }, 'move', i * COALESCE_MS * 3, { continues: true });
    }

    expect(history.past).toHaveLength(1);
    expect(at(undo(history))).toBe(0);
  });

  it('closes a gesture when the caller says it ended', () => {
    // Two drags in quick succession are two things, and time alone cannot tell them apart — the
    // second could begin a millisecond after the first ended.
    let history = pushHistory(start(), { x: 1 }, 'move', 0, { continues: true });
    history = pushHistory(history, { x: 2 }, 'move', 1, { ends: true });
    expect(history.past).toHaveLength(1);

    history = pushHistory(history, { x: 3 }, 'move', 2, { continues: true });
    expect(history.past).toHaveLength(2);
    expect(at(undo(history))).toBe(2);
  });

  it('keeps different actions separate however fast they follow', () => {
    let history = pushHistory(start(), { x: 1 }, 'move', 0);
    history = pushHistory(history, { x: 2 }, 'depth', 1);

    expect(history.past).toHaveLength(2);
  });

  it('honours a discrete edit that must never merge', () => {
    let history = pushHistory(start(), { x: 1 }, 'nudge', 0);
    history = pushHistory(history, { x: 2 }, 'nudge', 1, { discrete: true });

    expect(history.past).toHaveLength(2);
    expect(at(undo(history))).toBe(1);
  });

  it('forgets the oldest steps rather than growing without limit', () => {
    let history = start();
    for (let i = 1; i <= MAX_ENTRIES + 50; i++) {
      history = pushHistory(history, { x: i }, `step-${i}`, i * 1000);
    }

    expect(history.past).toHaveLength(MAX_ENTRIES);
    expect(at(history)).toBe(MAX_ENTRIES + 50);
  });
});

describe('undo and redo', () => {
  const three = () => {
    let history = pushHistory(start(), { x: 1 }, 'a', 0);
    history = pushHistory(history, { x: 2 }, 'b', 1000);
    return pushHistory(history, { x: 3 }, 'c', 2000);
  };

  it('walks back and forward through the same states', () => {
    const history = three();

    expect(at(undo(history))).toBe(2);
    expect(at(undo(undo(history)))).toBe(1);
    expect(at(undo(undo(undo(history))))).toBe(0);
    expect(at(redo(undo(history)))).toBe(3);
  });

  it('stops at the ends instead of throwing', () => {
    const empty = start();

    expect(undo(empty)).toEqual(empty);
    expect(redo(empty)).toEqual(empty);
    expect(canUndo(empty)).toBe(false);
    expect(canRedo(empty)).toBe(false);
  });

  it('drops the redo branch once a new edit is made', () => {
    const rewound = undo(three());
    expect(canRedo(rewound)).toBe(true);

    const diverged = pushHistory(rewound, { x: 99 }, 'd', 3000);
    expect(canRedo(diverged)).toBe(false);
    expect(at(undo(diverged))).toBe(2);
  });

  it('a merged drag is one press of undo, not twenty', () => {
    let history = pushHistory(start(), { x: 1 }, 'select', 0);
    for (let i = 1; i <= 30; i++) history = pushHistory(history, { x: 100 + i }, 'move', 1000 + i * 10);

    expect(at(undo(history))).toBe(1);
  });
});

describe('amendHistory', () => {
  it('corrects the current state without adding a step', () => {
    const history = pushHistory(start(), { x: 5 }, 'move', 0);
    const amended = amendHistory(history, { x: 4 });

    expect(at(amended)).toBe(4);
    expect(amended.past).toEqual(history.past);
    // Undo returns to what the user last chose, not to the correction.
    expect(at(undo(amended))).toBe(0);
  });
});
