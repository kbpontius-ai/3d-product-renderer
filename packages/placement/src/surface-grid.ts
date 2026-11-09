/**
 * A grid laid *on* an arbitrary surface, spaced by distance along that surface.
 *
 * This is what makes relief work on something that is neither flat nor a cylinder — an oval bottle,
 * a shoulder, a freeform CAD face. The existing conformal sampler fires a ray from the zone's frame
 * and takes the first hit, which puts the geometry in the right place and the *spacing* in the
 * wrong one: grid points evenly spaced across the frame land unevenly on a surface that tilts away,
 * stretched by `sec θ`. A 20 mm logo on the flank of an oval bottle comes out visibly wider than
 * 20 mm of bottle, and nothing in the system says so.
 *
 * So this walks instead of projecting. From a seed point on the surface it steps a fixed distance
 * in the tangent plane, drops back onto the surface, and corrects the step until the chord it
 * actually travelled matches the millimetres it was asked for — a discrete exponential map. On a
 * plane or a cylinder that is exact, which is the property the tests pin. On a doubly curved
 * surface no parameterisation can be exact (Gauss), so the remaining distortion is *measured* per
 * node rather than assumed away, and the caller is handed the number.
 *
 * The frame is carried along by discrete parallel transport: at each landing the direction is
 * re-projected into the new tangent plane. Over a zone-sized patch that keeps "up" meaning the same
 * thing at the far corner as at the centre.
 */
import type { Vec3 } from '@pr/design-schema';
import type { MeshIndex } from './mesh-index.js';
import { add, cross, dot, length, normalize, orthogonalize, scale, sub } from './vec.js';

export interface SurfaceGridOptions {
  /** Where on the part the zone's centre sits. Snapped to the surface before walking. */
  originMm: Vec3;
  /** The zone frame's normal — the direction the artwork faces. Seeds the walk. */
  normal: Vec3;
  /** The zone frame's tangent — +x in zone space. */
  tangent: Vec3;
  widthMm: number;
  heightMm: number;
  segmentsX: number;
  segmentsY: number;
  /**
   * How far off the frame the surface may be and still be found.
   *
   * Bounds both the initial snap and every re-projection during the walk, so a step that leaves the
   * part (over a rim, across a gap) fails rather than latching onto whatever is behind it.
   */
  maxProjectionDepthMm: number;
}

export interface SurfaceGrid {
  /** 3 per node, row-major, `segmentsY + 1` rows of `segmentsX + 1`. */
  position: Float32Array;
  normal: Float32Array;
  tangent: Float32Array;
  /** 1 per node: 1 where the walk stayed on the part, 0 where it ran off and was extrapolated. */
  support: Float32Array;
  /**
   * 1 per node: surface distance actually travelled per millimetre asked for.
   *
   * 1.0 is undistorted. This is measured from the walk rather than derived from a formula, so it
   * reports what the patch really did — including where the surface folded away and the step had to
   * be extrapolated.
   */
  metric: Float32Array;
  columns: number;
  rows: number;
  /** Worst metric over the nodes that stayed on the part. What the UI and the validator read. */
  maxMetric: number;
  /** Nodes the walk could not keep on the surface. */
  strayNodes: number;
}

/** Chord/arc agreement to aim for when correcting a step, and how hard to try. */
const STEP_TOLERANCE = 1e-3;
const STEP_ITERATIONS = 4;

interface Walker {
  position: Vec3;
  normal: Vec3;
  tangent: Vec3;
}

/**
 * One step of `distanceMm` along the surface, in the walker's tangent direction.
 *
 * The tangent step lands off the surface wherever it curves, so the guess is dropped back on and
 * the step lengthened until the chord matches. Two or three passes settle it at zone scale; the
 * loop exists because a single projection systematically *under*-runs on a convex surface, and an
 * under-run compounds across a row into a patch that is quietly too small.
 */
function stepAlong(
  mesh: MeshIndex,
  from: Walker,
  direction: Vec3,
  distanceMm: number,
  maxDropMm: number,
): Walker | null {
  if (distanceMm === 0) return from;

  let reach = distanceMm;
  let landed: Walker | null = null;

  for (let attempt = 0; attempt < STEP_ITERATIONS; attempt++) {
    const guess = add(from.position, scale(direction, reach));
    const hit = mesh.nearestSurface(guess, maxDropMm);
    if (!hit) return null;

    const travelled = length(sub(hit.position, from.position));
    landed = {
      position: hit.position,
      // Keep the walk on the side the zone faces: a thin part has surface behind it too.
      normal: dot(hit.normal, from.normal) < 0 ? scale(hit.normal, -1) : hit.normal,
      tangent: from.tangent,
    };
    if (travelled < 1e-9) return null;
    if (Math.abs(travelled - distanceMm) <= STEP_TOLERANCE * distanceMm) break;
    reach *= distanceMm / travelled;
  }

  return landed;
}

/** Carry a direction onto a new tangent plane, keeping it as parallel as the surface allows. */
function transport(direction: Vec3, normal: Vec3): Vec3 {
  const flattened = orthogonalize(direction, normal);
  return length(flattened) > 1e-9 ? normalize(flattened) : normalize(direction);
}

/** How far the walker actually got, per millimetre it was asked to travel. */
const travelledPerMm = (from: Vec3, to: Vec3, askedMm: number): number =>
  askedMm > 0 ? length(sub(to, from)) / askedMm : 1;

export function buildSurfaceGrid(mesh: MeshIndex, options: SurfaceGridOptions): SurfaceGrid {
  const { segmentsX, segmentsY, widthMm, heightMm, maxProjectionDepthMm } = options;
  const columns = segmentsX + 1;
  const rows = segmentsY + 1;
  const stepX = widthMm / segmentsX;
  const stepY = heightMm / segmentsY;

  const position = new Float32Array(columns * rows * 3);
  const normal = new Float32Array(columns * rows * 3);
  const tangent = new Float32Array(columns * rows * 3);
  const support = new Float32Array(columns * rows).fill(1);
  const metric = new Float32Array(columns * rows).fill(1);
  let strayNodes = 0;
  let maxMetric = 1;

  const frameNormal = normalize(options.normal);
  const frameTangent = transport(options.tangent, frameNormal);
  const frameBitangent = normalize(cross(frameNormal, frameTangent));

  /*
   * The anchor is a grid node, and the grid does not always have one at its centre.
   *
   * `patchResolution` spends its quad budget on square cells, so an odd segment count is ordinary —
   * 176 x 137 for this zone. Seeding at the frame origin and indexing at `segments / 2` then puts
   * the anchor half a step off the node it is written to, and on the odd axis the index itself is
   * fractional. So the anchor node is chosen first and the walk is seeded at *its* zone position.
   */
  const midCol = Math.floor(segmentsX / 2);
  const midRow = Math.floor(segmentsY / 2);
  const anchorZone = {
    x: (midCol / segmentsX - 0.5) * widthMm,
    y: (midRow / segmentsY - 0.5) * heightMm,
  };
  const anchorFramePoint = add(
    options.originMm,
    add(scale(frameTangent, anchorZone.x), scale(frameBitangent, anchorZone.y)),
  );

  /*
   * Seed on the surface, not on the frame.
   *
   * The zone's origin is authored against the frame and may sit above the part by as much as the
   * projection depth allows. Everything downstream measures distance *along the surface*, so the
   * walk has to start there or every row inherits the offset.
   */
  const seedHit =
    mesh.projectAlong(
      add(anchorFramePoint, scale(frameNormal, maxProjectionDepthMm)),
      scale(frameNormal, -1),
      maxProjectionDepthMm * 2,
    ) ?? mesh.nearestSurface(anchorFramePoint, maxProjectionDepthMm);

  const seededOnSurface = seedHit !== null;
  const centre: Walker = seedHit
    ? {
        position: seedHit.position,
        normal: dot(seedHit.normal, frameNormal) < 0 ? scale(seedHit.normal, -1) : seedHit.normal,
        tangent: transport(frameTangent, seedHit.normal),
      }
    : { position: anchorFramePoint, normal: frameNormal, tangent: frameTangent };

  const write = (col: number, row: number, walker: Walker, onSurface: boolean, stretch: number): void => {
    const node = row * columns + col;
    position[node * 3] = walker.position[0];
    position[node * 3 + 1] = walker.position[1];
    position[node * 3 + 2] = walker.position[2];
    normal[node * 3] = walker.normal[0];
    normal[node * 3 + 1] = walker.normal[1];
    normal[node * 3 + 2] = walker.normal[2];
    tangent[node * 3] = walker.tangent[0];
    tangent[node * 3 + 1] = walker.tangent[1];
    tangent[node * 3 + 2] = walker.tangent[2];
    if (!onSurface) {
      support[node] = 0;
      strayNodes++;
      return;
    }
    metric[node] = stretch;
    if (stretch > maxMetric) maxMetric = stretch;
  };

  /** Continue in a straight line once the surface has run out, so the grid stays well formed. */
  const driftOn = (walker: Walker, direction: Vec3, distanceMm: number): Walker => ({
    position: add(walker.position, scale(direction, distanceMm)),
    normal: walker.normal,
    tangent: walker.tangent,
  });

  /**
   * Fill one row outward from its anchor, in both directions along the row's tangent.
   *
   * `anchorOnSurface` is not a detail: a row seeded off the part cannot produce nodes that are on
   * it, and marking the anchor supported anyway would claim surface the walk never found.
   */
  const fillRow = (anchor: Walker, row: number, anchorOnSurface: boolean): void => {
    for (const sign of [1, -1] as const) {
      let walker = anchor;
      let onSurface = anchorOnSurface;

      for (let stepIndex = 1; ; stepIndex++) {
        const col = midCol + sign * stepIndex;
        if (col < 0 || col > segmentsX) break;

        const direction = scale(walker.tangent, sign);
        const next = onSurface ? stepAlong(mesh, walker, direction, stepX, maxProjectionDepthMm) : null;

        if (next) {
          const stretch = travelledPerMm(walker.position, next.position, stepX);
          walker = { ...next, tangent: transport(walker.tangent, next.normal) };
          write(col, row, walker, true, stretch);
        } else {
          onSurface = false;
          walker = driftOn(walker, direction, stepX);
          write(col, row, walker, false, 1);
        }
      }
    }

    write(midCol, row, anchor, anchorOnSurface, 1);
  };

  /*
   * The spine first, then the rows.
   *
   * Walking the centre column and fanning out from each of its nodes keeps the two families of
   * curves geodesic, which is what makes the millimetres real in both directions. A grid built by
   * walking rows only would accumulate all of the surface's curvature into the column spacing.
   */
  const spineDirection = (walker: Walker): Vec3 => {
    // Degenerate only if the transported tangent has collapsed onto the normal, which the frame
    // bitangent is the honest fallback for.
    const side = cross(walker.normal, walker.tangent);
    return length(side) > 1e-9 ? normalize(side) : frameBitangent;
  };

  fillRow(centre, midRow, seededOnSurface);

  for (const sign of [1, -1] as const) {
    let walker = centre;
    let onSurface = seededOnSurface;

    for (let stepIndex = 1; ; stepIndex++) {
      const row = midRow + sign * stepIndex;
      if (row < 0 || row > segmentsY) break;

      const direction = scale(spineDirection(walker), sign);
      const next = onSurface ? stepAlong(mesh, walker, direction, stepY, maxProjectionDepthMm) : null;

      if (next) {
        walker = { ...next, tangent: transport(walker.tangent, next.normal) };
      } else {
        onSurface = false;
        walker = driftOn(walker, direction, stepY);
      }
      fillRow(walker, row, onSurface);
    }
  }

  return { position, normal, tangent, support, metric, columns, rows, maxMetric, strayNodes };
}
