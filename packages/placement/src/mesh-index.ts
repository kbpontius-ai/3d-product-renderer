import type { Vec2, Vec3 } from '@pr/design-schema';

import type { MeshSampler, SurfacePoint } from './mappers.js';
import { cross, dot, length, normalize, orthogonalize, scale, sub } from './vec.js';

/**
 * A triangle lookup over a loaded mesh.
 *
 * `MeshSampler` has been declared in `mappers.ts` since the zone mappers were written and never had
 * an implementation, which is why `uv_rect` and `flat_panel` zones throw rather than map. This is
 * that implementation, and it answers three questions rather than one:
 *
 * - **UV → surface**, which is what a UV-space zone is defined in terms of.
 * - **World → UV**, which is what a zone patch needs so the substrate texture tiles continuously
 *   across the patch border instead of jumping at it (24-displaced-preview.md).
 * - **Ray → surface**, which is what a `conformal` zone means by "project onto the part".
 *
 * Plain typed arrays in and out: no three.js, no DOM. The caller adapts a `BufferGeometry`, and the
 * tests build a cube by hand. A uniform grid rather than a BVH — the meshes are tens to hundreds of
 * thousands of triangles and a grid is a hundred lines, which at this size is the better trade.
 */

export interface MeshArrays {
  /** 3 per vertex, in the same millimetre space zone frames are authored in. */
  position: Float32Array | number[];
  /** 3 per vertex. Interpolated, not recomputed — the mesh's own shading normals. */
  normal: Float32Array | number[];
  /** 2 per vertex. A mesh with no UVs can still answer world-space queries. */
  uv?: Float32Array | number[] | undefined;
  index?: Uint32Array | Uint16Array | number[] | undefined;
}

export interface MeshIndex extends MeshSampler {
  readonly triangleCount: number;
  readonly hasUvs: boolean;
  /** World position → the mesh's own UV there, or null if nothing is near enough. */
  uvAtWorld(p: Vec3, maxDistanceMm?: number): Vec2 | null;
  /**
   * Is there surface within `maxDistanceMm` of `p`, and if so what is its UV?
   *
   * The cheap question, and the one a patch actually asks. It answers "near enough" rather than
   * "nearest", so it stops at the first triangle in range instead of ranking every candidate, and
   * it remembers the triangle it last found — a patch walks a regular lattice, so the answer for
   * one vertex is very often the answer for the next.
   *
   * Not thread-safe and not reentrant, by construction: the memo is one slot on the index.
   */
  probeNear(
    p: Vec3,
    maxDistanceMm: number,
  ): { uv: Vec2 | null; distanceMm: number; normal: Vec3 } | null;
  /** Nearest point on the surface to `p`, or null beyond `maxDistanceMm`. */
  nearestSurface(p: Vec3, maxDistanceMm?: number): SurfacePoint | null;
  /** First hit along a ray, or null. Used by conformal zones to find the real surface. */
  projectAlong(origin: Vec3, direction: Vec3, maxDistanceMm: number): SurfacePoint | null;
}

/** How many buckets per axis, from triangle count. Aims at a handful of triangles per bucket. */
function gridSize(triangles: number, axes: number): number {
  const perAxis = Math.round(Math.cbrt(Math.max(1, triangles)) * (axes === 2 ? 1.6 : 1));
  return Math.max(1, Math.min(128, perAxis));
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** A bucketed triangle list. `cellOf` maps a point to a linear bucket; both grids share the code. */
interface Buckets {
  size: number;
  min: number[];
  span: number[];
  cells: Int32Array[];
}

function buildBuckets(
  triangles: number,
  axes: number,
  boundsOf: (t: number) => { lo: number[]; hi: number[] },
  bounds: { min: number[]; max: number[] },
): Buckets {
  const size = gridSize(triangles, axes);
  const span = bounds.max.map((hi, a) => Math.max(1e-9, hi - bounds.min[a]!));
  const lists: number[][] = Array.from({ length: size ** axes }, () => []);

  const cellIndex = (coords: number[]): number => {
    let index = 0;
    for (let a = axes - 1; a >= 0; a--) index = index * size + coords[a]!;
    return index;
  };
  const clampCell = (value: number, a: number): number =>
    Math.max(0, Math.min(size - 1, Math.floor(((value - bounds.min[a]!) / span[a]!) * size)));

  for (let t = 0; t < triangles; t++) {
    const { lo, hi } = boundsOf(t);
    const loCell = lo.map(clampCell);
    const hiCell = hi.map(clampCell);
    // A triangle lands in every bucket its own bounding box touches, so a query only ever has to
    // look at the bucket it falls in plus its immediate neighbours.
    if (axes === 2) {
      for (let y = loCell[1]!; y <= hiCell[1]!; y++)
        for (let x = loCell[0]!; x <= hiCell[0]!; x++) lists[cellIndex([x, y])]!.push(t);
    } else {
      for (let z = loCell[2]!; z <= hiCell[2]!; z++)
        for (let y = loCell[1]!; y <= hiCell[1]!; y++)
          for (let x = loCell[0]!; x <= hiCell[0]!; x++) lists[cellIndex([x, y, z])]!.push(t);
    }
  }

  return {
    size,
    min: bounds.min,
    span,
    cells: lists.map((list) => Int32Array.from(list)),
  };
}

function bucketAxis(buckets: Buckets, value: number, axis: number): number {
  const cell = Math.floor(((value - buckets.min[axis]!) / buckets.span[axis]!) * buckets.size);
  return Math.max(0, Math.min(buckets.size - 1, cell));
}

/**
 * Visits the buckets within `ring` of `point`. Returning true from `visit` stops the walk.
 *
 * Written as explicit loops rather than a recursive walk building coordinate arrays, and handing
 * back the bucket rather than collecting buckets into a list, because this is on the per-vertex
 * path: a patch at the top quality level asks a quarter of a million questions, and a walk that
 * allocates twenty-seven small arrays per question spends its entire budget in the collector.
 */
function eachCandidate(
  buckets: Buckets,
  point: readonly number[],
  ring: number,
  visit: (cell: Int32Array) => boolean,
): boolean {
  const size = buckets.size;
  const axes = point.length;
  const cx = bucketAxis(buckets, point[0]!, 0);
  const cy = bucketAxis(buckets, point[1]!, 1);
  const cz = axes > 2 ? bucketAxis(buckets, point[2]!, 2) : 0;

  for (let dz = -ring; dz <= ring; dz++) {
    const z = cz + dz;
    if (axes > 2 && (z < 0 || z >= size)) continue;
    for (let dy = -ring; dy <= ring; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= size) continue;
      for (let dx = -ring; dx <= ring; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= size) continue;
        const index = axes > 2 ? x + size * (y + size * z) : x + size * y;
        const cell = buckets.cells[index];
        if (cell && cell.length && visit(cell)) return true;
      }
    }
    if (axes === 2) break; // the z loop runs once for a 2D grid
  }
  return false;
}

/** Barycentric coordinates of `p` in the 2D triangle `a,b,c`, or null if the triangle is degenerate. */
function barycentric2d(p: Vec2, a: Vec2, b: Vec2, c: Vec2): [number, number, number] | null {
  const v0x = b.x - a.x;
  const v0y = b.y - a.y;
  const v1x = c.x - a.x;
  const v1y = c.y - a.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-14) return null;

  const px = p.x - a.x;
  const py = p.y - a.y;
  const v = (px * v1y - v1x * py) / denominator;
  const w = (v0x * py - px * v0y) / denominator;
  return [1 - v - w, v, w];
}

/** Closest point to `p` on the triangle `a,b,c` — Ericson, Real-Time Collision Detection §5.1.5. */
function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): { point: Vec3; bary: [number, number, number] } {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, bary: [1, 0, 0] };

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, bary: [0, 1, 0] };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { point: add3(a, scale(ab, v)), bary: [1 - v, v, 0] };
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, bary: [0, 0, 1] };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { point: add3(a, scale(ac, w)), bary: [1 - w, 0, w] };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { point: add3(b, scale(sub(c, b), w)), bary: [0, 1 - w, w] };
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return { point: add3(a, add3(scale(ab, v), scale(ac, w))), bary: [1 - v - w, v, w] };
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Möller–Trumbore, two-sided: a zone frame may sit either side of the surface it projects onto. */
function rayTriangle(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const h = cross(direction, edge2);
  const det = dot(edge1, h);
  if (Math.abs(det) < 1e-12) return null;

  const invDet = 1 / det;
  const s = sub(origin, a);
  const u = invDet * dot(s, h);
  if (u < -1e-6 || u > 1 + 1e-6) return null;

  const q = cross(s, edge1);
  const v = invDet * dot(direction, q);
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;

  const t = invDet * dot(edge2, q);
  return t > 1e-9 ? t : null;
}

type Bary = [number, number, number];
interface UvHit {
  triangle: number;
  bary: Bary;
  /** How far outside the triangle the query fell, in barycentric units. Zero means inside. */
  slack: number;
}
interface WorldHit {
  triangle: number;
  bary: Bary;
  distance: number;
}
interface RayHit {
  /** Distance along the ray. */
  t: number;
  triangle: number;
}

export function buildMeshIndex(mesh: MeshArrays): MeshIndex {
  const position = mesh.position;
  const normal = mesh.normal;
  const uv = mesh.uv;
  const index =
    mesh.index ?? Uint32Array.from({ length: Math.floor(position.length / 3) }, (_, i) => i);
  const triangleCount = Math.floor(index.length / 3);
  const hasUvs = Boolean(uv && uv.length >= 6);

  const corner = (t: number, k: number): number => index[t * 3 + k]!;
  const vertex = (v: number): Vec3 => [position[v * 3]!, position[v * 3 + 1]!, position[v * 3 + 2]!];
  const vertexNormal = (v: number): Vec3 => [normal[v * 3]!, normal[v * 3 + 1]!, normal[v * 3 + 2]!];
  const vertexUv = (v: number): Vec2 =>
    hasUvs ? { x: uv![v * 2]!, y: uv![v * 2 + 1]! } : { x: 0, y: 0 };

  const worldBounds: Bounds = { min: [0, 0, 0], max: [0, 0, 0] };
  if (triangleCount > 0) {
    worldBounds.min = [Infinity, Infinity, Infinity];
    worldBounds.max = [-Infinity, -Infinity, -Infinity];
  }
  for (let v = 0; triangleCount > 0 && v * 3 < position.length; v++) {
    for (let a = 0; a < 3; a++) {
      const value = position[v * 3 + a]!;
      if (value < worldBounds.min[a]!) worldBounds.min[a] = value;
      if (value > worldBounds.max[a]!) worldBounds.max[a] = value;
    }
  }

  const worldGrid = buildBuckets(
    triangleCount,
    3,
    (t) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        const p = vertex(corner(t, k));
        for (let a = 0; a < 3; a++) {
          if (p[a]! < lo[a]!) lo[a] = p[a]!;
          if (p[a]! > hi[a]!) hi[a] = p[a]!;
        }
      }
      return { lo, hi };
    },
    worldBounds,
  );

  const uvGrid = hasUvs
    ? buildBuckets(
        triangleCount,
        2,
        (t) => {
          const lo = [Infinity, Infinity];
          const hi = [-Infinity, -Infinity];
          for (let k = 0; k < 3; k++) {
            const p = vertexUv(corner(t, k));
            const values = [p.x, p.y];
            for (let a = 0; a < 2; a++) {
              if (values[a]! < lo[a]!) lo[a] = values[a]!;
              if (values[a]! > hi[a]!) hi[a] = values[a]!;
            }
          }
          return { lo, hi };
        },
        { min: [0, 0], max: [1, 1] },
      )
    : null;

  /** One step of a ray march: the nearest triangle it hits among buckets not already tested. */
  function scanRayStep(
    origin: Vec3,
    ray: Vec3,
    along: number,
    maxDistanceMm: number,
    seen: Set<number>,
  ): RayHit | null {
    const point: number[] = [
      origin[0] + ray[0] * along,
      origin[1] + ray[1] * along,
      origin[2] + ray[2] * along,
    ];
    let best: RayHit | null = null;

    eachCandidate(worldGrid, point, 1, (cell) => {
      for (const t of cell) {
        if (seen.has(t)) continue;
        seen.add(t);
        const hit = rayTriangle(
          origin,
          ray,
          vertex(corner(t, 0)),
          vertex(corner(t, 1)),
          vertex(corner(t, 2)),
        );
        if (hit !== null && hit <= maxDistanceMm && (!best || hit < best.t)) {
          best = { t: hit, triangle: t };
        }
      }
      return false;
    });
    return best;
  }

  /** Interpolate a triangle's attributes at barycentric weights. */
  function surfaceAt(t: number, bary: [number, number, number]): SurfacePoint {
    const [ia, ib, ic] = [corner(t, 0), corner(t, 1), corner(t, 2)];
    const pa = vertex(ia);
    const pb = vertex(ib);
    const pc = vertex(ic);
    const blend = (f: (v: number) => Vec3): Vec3 =>
      add3(add3(scale(f(ia), bary[0]), scale(f(ib), bary[1])), scale(f(ic), bary[2]));

    // The geometric normal is the fallback: a mesh may carry zero-length shading normals, and a
    // patch built on a zero normal displaces nowhere and shades black.
    const shading = blend(vertexNormal);
    const geometric = cross(sub(pb, pa), sub(pc, pa));
    const usable = length(shading) > 1e-6 ? shading : geometric;
    const surfaceNormal = normalize(usable);

    return {
      position: blend(vertex),
      normal: surfaceNormal,
      tangent: uvTangent(t, pa, pb, pc, surfaceNormal),
    };
  }

  /**
   * The world direction of increasing `u`, orthogonalised against the normal.
   *
   * It matters which way this points. A UV-space zone maps its own +x onto increasing `u`, and the
   * patch perturbs normals along the tangent it is handed — so handing back an arbitrary triangle
   * edge would light the relief as though the artwork were rotated by however that triangle happens
   * to be wound. Falls back to an edge only where the UVs are degenerate.
   */
  function uvTangent(t: number, pa: Vec3, pb: Vec3, pc: Vec3, surfaceNormal: Vec3): Vec3 {
    const edge = () => orthogonalize(sub(pb, pa), surfaceNormal);
    if (!hasUvs) return edge();

    const ua = vertexUv(corner(t, 0));
    const ub = vertexUv(corner(t, 1));
    const uc = vertexUv(corner(t, 2));
    const du1 = ub.x - ua.x;
    const dv1 = ub.y - ua.y;
    const du2 = uc.x - ua.x;
    const dv2 = uc.y - ua.y;
    const determinant = du1 * dv2 - du2 * dv1;
    if (Math.abs(determinant) < 1e-14) return edge();

    const e1 = sub(pb, pa);
    const e2 = sub(pc, pa);
    const tangent: Vec3 = [
      (dv2 * e1[0] - dv1 * e2[0]) / determinant,
      (dv2 * e1[1] - dv1 * e2[1]) / determinant,
      (dv2 * e1[2] - dv1 * e2[2]) / determinant,
    ];
    return length(tangent) > 1e-9 ? orthogonalize(tangent, surfaceNormal) : edge();
  }

  function triangleUvAt(t: number, bary: [number, number, number]): Vec2 {
    const a = vertexUv(corner(t, 0));
    const b = vertexUv(corner(t, 1));
    const c = vertexUv(corner(t, 2));
    return {
      x: a.x * bary[0] + b.x * bary[1] + c.x * bary[2],
      y: a.y * bary[0] + b.y * bary[1] + c.y * bary[2],
    };
  }

  /**
   * One ring of UV buckets: the triangle that contains `target`, and the nearest one that does not.
   *
   * Split out from the ring walk because a search that mutates an accumulator three loops deep is
   * beyond what TypeScript's control-flow analysis will follow — it stops widening the accumulator
   * and every later read is against `null`. One loop level per function keeps the types honest and
   * reads better besides.
   */
  function scanUvRing(target: Vec2, ring: number): { exact: UvHit | null; nearest: UvHit | null } {
    if (!uvGrid) return { exact: null, nearest: null };
    let nearest: UvHit | null = null;
    let exact: UvHit | null = null;
    const point: [number, number] = [target.x, target.y];

    eachCandidate(uvGrid, point, ring, (cell) => {
      for (const t of cell) {
        const bary = barycentric2d(
          target,
          vertexUv(corner(t, 0)),
          vertexUv(corner(t, 1)),
          vertexUv(corner(t, 2)),
        );
        if (!bary) continue;
        if (bary[0] >= -1e-9 && bary[1] >= -1e-9 && bary[2] >= -1e-9) {
          exact = { triangle: t, bary, slack: 0 };
          return true;
        }
        // Remember the near miss: UV rectangles authored to the edge of an island land just
        // outside a triangle at the boundary, and refusing there would punch holes in the patch.
        const slack = -Math.min(bary[0], bary[1], bary[2]);
        if (!nearest || slack < nearest.slack) nearest = { triangle: t, bary, slack };
      }
      return false;
    });
    return { exact, nearest };
  }

  /** The triangle whose UV image contains `target`, with its barycentric weights. */
  function triangleForUv(target: Vec2): { triangle: number; bary: [number, number, number] } | null {
    if (!uvGrid) return null;
    let bestOutside: UvHit | null = null;

    for (let ring = 0; ring <= 2; ring++) {
      const scanned = scanUvRing(target, ring);
      if (scanned.exact) return { triangle: scanned.exact.triangle, bary: scanned.exact.bary };
      const near = scanned.nearest;
      if (near && (!bestOutside || near.slack < bestOutside.slack)) bestOutside = near;
      if (bestOutside && bestOutside.slack < 0.05) break;
    }

    if (bestOutside && bestOutside.slack < 0.25) {
      return { triangle: bestOutside.triangle, bary: clampBary(bestOutside.bary) };
    }
    return null;
  }

  /** The closest triangle within one ring of world buckets. See `scanUvRing` on why it is split. */
  function scanWorldRing(p: Vec3, ring: number): WorldHit | null {
    let best: WorldHit | null = null;
    eachCandidate(worldGrid, p, ring, (cell) => {
      for (const t of cell) {
        const hit = closestOnTriangle(p, vertex(corner(t, 0)), vertex(corner(t, 1)), vertex(corner(t, 2)));
        const distance = length(sub(hit.point, p));
        if (!best || distance < best.distance) best = { triangle: t, bary: hit.bary, distance };
      }
      return false;
    });
    return best;
  }

  /**
   * The triangle the last probe found. A patch walks a lattice, so the next vertex is usually
   * within a fraction of a millimetre of the last one and lands on the same triangle.
   */
  let recent = -1;

  function testTriangle(p: Vec3, t: number, maxDistanceMm: number): WorldHit | null {
    const hit = closestOnTriangle(p, vertex(corner(t, 0)), vertex(corner(t, 1)), vertex(corner(t, 2)));
    const distance = length(sub(hit.point, p));
    return distance <= maxDistanceMm ? { triangle: t, bary: hit.bary, distance } : null;
  }

  /**
   * Any triangle within `maxDistanceMm`, not necessarily the closest.
   *
   * "Near enough" is a much cheaper question than "nearest": it stops at the first hit rather than
   * ranking every candidate, and it only widens the bucket ring as far as the tolerance can reach.
   * For a patch vertex the two answers are the same in every case that matters — a point on the
   * surface is inside exactly one triangle, and points on a shared edge agree.
   */
  function probeTriangle(p: Vec3, maxDistanceMm: number): WorldHit | null {
    if (triangleCount === 0) return null;

    if (recent >= 0) {
      const again = testTriangle(p, recent, maxDistanceMm);
      if (again) return again;
    }

    // How far the tolerance reaches in buckets. Usually zero: the bucket is millimetres across and
    // the tolerance is a fraction of one.
    const bucketMm = Math.max(
      worldGrid.span[0]!,
      Math.max(worldGrid.span[1]!, worldGrid.span[2]!),
    ) / worldGrid.size;
    const reach = Math.min(3, Math.ceil(maxDistanceMm / Math.max(1e-6, bucketMm)));

    let found: WorldHit | null = null;
    for (let ring = 0; ring <= reach && !found; ring++) {
      eachCandidate(worldGrid, p, ring, (cell) => {
        for (const t of cell) {
          const hit = testTriangle(p, t, maxDistanceMm);
          if (hit) {
            found = hit;
            return true;
          }
        }
        return false;
      });
    }

    if (found) recent = (found as WorldHit).triangle;
    return found;
  }

  function nearestTriangle(p: Vec3, maxDistanceMm: number): WorldHit | null {
    let best: WorldHit | null = null;

    for (let ring = 0; ring <= 3; ring++) {
      const found = scanWorldRing(p, ring);
      if (found && (!best || found.distance < best.distance)) best = found;
      // One ring past the first hit, because a nearer triangle can sit in a neighbouring bucket.
      if (best && ring >= 1) break;
    }

    return best && best.distance <= maxDistanceMm ? best : null;
  }

  return {
    triangleCount,
    hasUvs,

    sampleByUv(target: Vec2): SurfacePoint {
      const found = triangleForUv(target);
      if (!found) {
        throw new MeshSampleError(
          `no triangle covers uv (${target.x.toFixed(4)}, ${target.y.toFixed(4)})`,
        );
      }
      return surfaceAt(found.triangle, found.bary);
    },

    /**
     * Millimetres of surface per UV unit, as the mappers' distortion check wants it.
     *
     * Measured as the ratio of the triangle's world area to its UV area, which is the local scale
     * factor of the parameterisation and does not care how the triangle happens to be oriented.
     */
    uvMetricAt(target: Vec2): number {
      const found = triangleForUv(target);
      if (!found) return 1;
      const t = found.triangle;
      const [pa, pb, pc] = [vertex(corner(t, 0)), vertex(corner(t, 1)), vertex(corner(t, 2))];
      const worldArea = length(cross(sub(pb, pa), sub(pc, pa))) / 2;
      const [ua, ub, uc] = [vertexUv(corner(t, 0)), vertexUv(corner(t, 1)), vertexUv(corner(t, 2))];
      const uvArea =
        Math.abs((ub.x - ua.x) * (uc.y - ua.y) - (uc.x - ua.x) * (ub.y - ua.y)) / 2;
      if (uvArea < 1e-14) return 1;
      return Math.sqrt(worldArea / uvArea);
    },

    uvAtWorld(p: Vec3, maxDistanceMm = 1): Vec2 | null {
      if (!hasUvs) return null;
      const found = nearestTriangle(p, maxDistanceMm);
      return found ? triangleUvAt(found.triangle, found.bary) : null;
    },

    probeNear(p: Vec3, maxDistanceMm: number) {
      const found = probeTriangle(p, maxDistanceMm);
      if (!found) return null;
      return {
        uv: hasUvs ? triangleUvAt(found.triangle, found.bary) : null,
        distanceMm: found.distance,
        // The caller needs to know not just that surface is near, but which surface. A point just
        // past the rim of a closure's top face is within a fraction of a millimetre of the skirt,
        // and the two are told apart by where they face, not by how close they are.
        normal: surfaceAt(found.triangle, found.bary).normal,
      };
    },

    nearestSurface(p: Vec3, maxDistanceMm = Infinity): SurfacePoint | null {
      const found = nearestTriangle(p, maxDistanceMm);
      return found ? surfaceAt(found.triangle, found.bary) : null;
    },

    projectAlong(origin: Vec3, direction: Vec3, maxDistanceMm: number): SurfacePoint | null {
      const ray = normalize(direction);
      let best: RayHit | null = null;

      // March along the ray through the world grid rather than testing every triangle: a conformal
      // patch fires one of these per vertex, tens of thousands of times.
      const steps = Math.max(2, worldGrid.size);
      const seen = new Set<number>();
      for (let s = 0; s <= steps; s++) {
        const along = (maxDistanceMm * s) / steps;
        const found = scanRayStep(origin, ray, along, maxDistanceMm, seen);
        if (found && (!best || found.t < best.t)) best = found;
        if (best && best.t <= along) break; // Nothing further along the ray can be nearer.
      }

      if (!best) return null;
      const point: Vec3 = [
        origin[0] + ray[0] * best.t,
        origin[1] + ray[1] * best.t,
        origin[2] + ray[2] * best.t,
      ];
      const hit = closestOnTriangle(
        point,
        vertex(corner(best.triangle, 0)),
        vertex(corner(best.triangle, 1)),
        vertex(corner(best.triangle, 2)),
      );
      return surfaceAt(best.triangle, hit.bary);
    },
  };
}

function clampBary(bary: [number, number, number]): [number, number, number] {
  const clamped: [number, number, number] = [
    Math.max(0, bary[0]),
    Math.max(0, bary[1]),
    Math.max(0, bary[2]),
  ];
  const sum = clamped[0] + clamped[1] + clamped[2];
  if (sum < 1e-12) return [1, 0, 0];
  return [clamped[0] / sum, clamped[1] / sum, clamped[2] / sum];
}

export class MeshSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshSampleError';
  }
}
