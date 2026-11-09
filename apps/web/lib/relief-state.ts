/**
 * What the preview actually drew the relief with, and whether two answers are the same.
 *
 * Lives here rather than in `viewport-3d.tsx` because the comparison is the load-bearing part and
 * it is pure: a component that pulls in three.js and react-three-fiber cannot be imported by a
 * node test, and this is exactly the logic worth testing.
 */
export type ReliefState =
  | {
      kind: 'displaced';
      triangles: number;
      segmentsX: number;
      segmentsY: number;
      spacingMm: number;
      fallbackVertices: number;
      clippedTriangles: number;
      /**
       * Product vertices carrying a conformal zone's coordinates (zone kind 3). Zero for every
       * other zone, and for a conformal zone that has fallen back to being treated as planar.
       */
      bodyVertices: number;
    }
  | { kind: 'shaded' };

/**
 * Field-wise equality, so an unchanged rebuild reports nothing.
 *
 * The readout is React state owned by the viewport, so *reporting* re-renders the viewport and the
 * product inside it. Reporting unconditionally — a freshly built object every time the effect ran —
 * made that a loop waiting for a reason: anything that gives the patch a new identity per render
 * turns "rebuild once" into "rebuild forever", and each rebuild walks tens of thousands of
 * vertices. Comparing first is what cuts the feedback path.
 */
export function sameRelief(a: ReliefState | null, b: ReliefState): boolean {
  if (a === null || a.kind !== b.kind) return false;
  if (a.kind !== 'displaced' || b.kind !== 'displaced') return true;
  return (
    a.triangles === b.triangles &&
    a.segmentsX === b.segmentsX &&
    a.segmentsY === b.segmentsY &&
    a.spacingMm === b.spacingMm &&
    a.fallbackVertices === b.fallbackVertices &&
    a.clippedTriangles === b.clippedTriangles &&
    a.bodyVertices === b.bodyVertices
  );
}
