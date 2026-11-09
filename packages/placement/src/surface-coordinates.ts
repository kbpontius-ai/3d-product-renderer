import type { Vec3 } from '@pr/design-schema';
import { cross } from './vec.js';
import type { MeshArrays } from './mesh-index.js';
import type { ZonePatch } from './patch.js';

/**
 * Zone millimetres for the product's own vertices, read off a patch that was walked across them.
 *
 * The preview draws a decorated zone twice (docs/24): the dense patch carrying the relief, and the
 * product's coarse mesh underneath, which has to get out of the way wherever a deboss dips below
 * it. To do that the product needs to know where in the zone each of its fragments is. For planar,
 * cylindrical and UV zones it can work that out analytically. For a conformal zone it cannot: the
 * patch measures zone millimetres *along* the surface, by walking it, and there is no closed form
 * for that walk. The shader used to treat a conformal zone as planar instead — a projection onto
 * the frame plane, only counted within `maxProjectionDepthMm` of it — so on a 75 mm radius with
 * a 1 mm depth the product stopped knowing it was in the zone 12 mm from the centre, kept drawing,
 * and hid the pocket of every letter beyond that.
 *
 * So the coordinates are handed over instead of rederived. Each vertex takes the zone coordinate of
 * the nearest supported patch node plus its offset from that node in the node's own tangent frame.
 * That is exact at the nodes, second order between them, and extrapolates past the patch's edge.
 * The extrapolation is needed because the product's triangles can be far larger than the zone. A
 * CAD cylinder is often long strips running its full height, so a triangle crossing the zone may
 * have every vertex outside it, and its interpolated coordinate is only right if all three have one.
 */

export interface SurfaceCoordinates {
  /** 3 per vertex: zone x mm, zone y mm, and 1 where the vertex belongs to the zone's surface. */
  coordinates: Float32Array;
  /** How many vertices got a coordinate. Zero means nothing here can use them. */
  valid: number;
}

export interface SurfaceCoordinateOptions {
  /** Minimum dot(vertex normal, patch normal); the zone's own alignment floor. */
  alignmentMin: number;
  /** How far off the patch's tangent plane a vertex may sit before curvature has to explain it. */
  surfaceToleranceMm?: number;
}

/** Coarse-search lattice size per axis. Hill-climbing on the full grid takes it from there. */
const COARSE = 48;

export function surfaceCoordinates(
  patch: ZonePatch,
  extent: { w: number; h: number },
  mesh: MeshArrays,
  options: SurfaceCoordinateOptions,
): SurfaceCoordinates {
  const tolerance = options.surfaceToleranceMm ?? 1;
  const vertexCount = mesh.position.length / 3;
  const coordinates = new Float32Array(vertexCount * 3);
  const { segmentsX, segmentsY } = patch.resolution;
  const columns = segmentsX + 1;
  const rows = segmentsY + 1;
  const P = patch.position;
  const supported = (node: number): boolean => patch.support[node]! >= 0.5;

  // Where the patch is, as a sphere, so triangles nowhere near it cost one comparison.
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (let node = 0; node < columns * rows; node++) {
    if (!supported(node)) continue;
    any = true;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, P[node * 3 + a]!);
      max[a] = Math.max(max[a]!, P[node * 3 + a]!);
    }
  }
  if (!any) return { coordinates, valid: 0 };
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;

  const V = mesh.position;
  const N = mesh.normal;
  const dist = (vertex: number, to: Vec3): number =>
    Math.hypot(V[vertex * 3]! - to[0], V[vertex * 3 + 1]! - to[1], V[vertex * 3 + 2]! - to[2]);

  // A vertex is a candidate when a triangle it belongs to reaches the patch at all — however far
  // the vertex itself is from it.
  const candidate = new Uint8Array(vertexCount);
  const index = mesh.index ?? Array.from({ length: vertexCount }, (_, i) => i);
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]!,
      b = index[t + 1]!,
      c = index[t + 2]!;
    const mid: Vec3 = [0, 1, 2].map(
      (k) => (V[a * 3 + k]! + V[b * 3 + k]! + V[c * 3 + k]!) / 3,
    ) as Vec3;
    const reach = Math.max(dist(a, mid), dist(b, mid), dist(c, mid));
    const gap = Math.hypot(mid[0] - centre[0], mid[1] - centre[1], mid[2] - centre[2]);
    if (gap <= radius + reach) candidate[a] = candidate[b] = candidate[c] = 1;
  }

  const strideX = Math.max(1, Math.ceil(segmentsX / COARSE));
  const strideY = Math.max(1, Math.ceil(segmentsY / COARSE));
  const coarse: number[] = [];
  for (let j = 0; j < rows; j += strideY) {
    for (let i = 0; i < columns; i += strideX)
      if (supported(j * columns + i)) coarse.push(j * columns + i);
  }
  // The last row and column are what the extrapolation starts from past the far edges.
  for (let j = 0; j < rows; j += strideY)
    if (supported(j * columns + segmentsX)) coarse.push(j * columns + segmentsX);
  for (let i = 0; i < columns; i += strideX)
    if (supported(segmentsY * columns + i)) coarse.push(segmentsY * columns + i);

  const d2 = (vertex: number, node: number): number => {
    const x = V[vertex * 3]! - P[node * 3]!;
    const y = V[vertex * 3 + 1]! - P[node * 3 + 1]!;
    const z = V[vertex * 3 + 2]! - P[node * 3 + 2]!;
    return x * x + y * y + z * z;
  };

  let valid = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    if (!candidate[vertex]) continue;

    let best = coarse[0]!;
    let bestD = Infinity;
    for (const node of coarse) {
      const d = d2(vertex, node);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
    }
    // Downhill on the full grid: the coarse answer is within a stride of the true nearest node.
    for (let moved = true; moved;) {
      moved = false;
      const i0 = best % columns;
      const j0 = (best - i0) / columns;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = i0 + di,
            j = j0 + dj;
          if ((di === 0 && dj === 0) || i < 0 || j < 0 || i >= columns || j >= rows) continue;
          const node = j * columns + i;
          if (!supported(node)) continue;
          const d = d2(vertex, node);
          if (d < bestD) {
            bestD = d;
            best = node;
            moved = true;
          }
        }
      }
    }

    const n: Vec3 = [
      patch.normal[best * 3]!,
      patch.normal[best * 3 + 1]!,
      patch.normal[best * 3 + 2]!,
    ];
    const t: Vec3 = [
      patch.tangent[best * 3]!,
      patch.tangent[best * 3 + 1]!,
      patch.tangent[best * 3 + 2]!,
    ];
    const b = cross(n, t); // zone +y, as the shader and the planar frame both define it
    const offset: Vec3 = [
      V[vertex * 3]! - P[best * 3]!,
      V[vertex * 3 + 1]! - P[best * 3 + 1]!,
      V[vertex * 3 + 2]! - P[best * 3 + 2]!,
    ];
    const along = offset[0] * t[0] + offset[1] * t[1] + offset[2] * t[2];
    const across = offset[0] * b[0] + offset[1] * b[1] + offset[2] * b[2];
    const off = Math.abs(offset[0] * n[0] + offset[1] * n[1] + offset[2] * n[2]);

    const i = best % columns;
    const j = (best - i) / columns;
    coordinates[vertex * 3] = (i / segmentsX - 0.5) * extent.w + along;
    coordinates[vertex * 3 + 1] = (j / segmentsY - 0.5) * extent.h + across;

    /*
     * Two ways a vertex can be near the patch without being on its surface.
     *
     * Facing away — the back of the part, the inside of its own wall: the normal test. Facing the
     * same way but behind it — the inside of the *far* wall of a hollow container, which looks
     * straight out through the zone and would otherwise map into the middle of it: the plane test.
     * Real surface curving away from the patch passes the plane test, because it leaves the plane
     * slowly compared with how far it has gone along it; a wall behind the zone leaves it at once.
     */
    const nx = N[vertex * 3]!,
      ny = N[vertex * 3 + 1]!,
      nz = N[vertex * 3 + 2]!;
    const normalLength = Math.hypot(nx, ny, nz);
    const facing =
      normalLength < 0.5 ||
      (nx * n[0] + ny * n[1] + nz * n[2]) / normalLength >= options.alignmentMin;
    const tangential = Math.sqrt(Math.max(0, bestD - off * off));
    if (facing && off <= tolerance + 0.5 * tangential) {
      coordinates[vertex * 3 + 2] = 1;
      valid++;
    }
  }

  return { coordinates, valid };
}
