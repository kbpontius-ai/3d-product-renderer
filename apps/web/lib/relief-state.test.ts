import { describe, expect, it } from 'vitest';
import { sameRelief, type ReliefState } from './relief-state';

/**
 * The guard that stops the preview reporting its own readout in a loop.
 *
 * Reporting is a `setState` on the viewport, so a report re-renders the product inside it. When the
 * report was unconditional, any dependency that gave the patch a fresh identity per render turned
 * one rebuild into an unbounded chain of them — measured with a deliberately churning dependency, a
 * single colour change went from 60 ms to about five seconds, and React eventually failed with
 * "Maximum update depth exceeded" pointing at the effect that reports.
 */

const displaced = (over: Partial<Extract<ReliefState, { kind: 'displaced' }>> = {}): ReliefState => ({
  kind: 'displaced',
  triangles: 46548,
  segmentsX: 155,
  segmentsY: 155,
  spacingMm: 0.194,
  fallbackVertices: 0,
  clippedTriangles: 1502,
  bodyVertices: 0,
  ...over,
});

describe('sameRelief', () => {
  it('treats a rebuild that produced the same numbers as the same', () => {
    // The case that matters: two distinct objects, identical content. Rebuilding the patch without
    // changing the quality level lands here, and it must not report.
    expect(sameRelief(displaced(), displaced())).toBe(true);
  });

  it('reports the first answer of all, because there is nothing to compare it to', () => {
    expect(sameRelief(null, displaced())).toBe(false);
    expect(sameRelief(null, { kind: 'shaded' })).toBe(false);
  });

  it('notices the fallback going either way', () => {
    // Displaced -> shaded is the silent degradation the readout exists to expose; it must report.
    expect(sameRelief(displaced(), { kind: 'shaded' })).toBe(false);
    expect(sameRelief({ kind: 'shaded' }, displaced())).toBe(false);
    expect(sameRelief({ kind: 'shaded' }, { kind: 'shaded' })).toBe(true);
  });

  it('notices every field a real quality change moves', () => {
    // Each of these is something the quality ladder or a zone change actually alters, so each has
    // to defeat the guard on its own — a guard that only watched the triangle count would let a
    // resolution change through unreported.
    const moved: Partial<Extract<ReliefState, { kind: 'displaced' }>>[] = [
      { triangles: 46549 },
      { segmentsX: 154 },
      { segmentsY: 154 },
      { spacingMm: 0.195 },
      { fallbackVertices: 1 },
      { clippedTriangles: 1503 },
      { bodyVertices: 1 },
    ];
    for (const over of moved) {
      expect(sameRelief(displaced(), displaced(over)), JSON.stringify(over)).toBe(false);
    }
  });
});
