import type { DecorationZoneDef, Vec2, Vec3 } from '@pr/design-schema';
import { zoneExtentMm } from '@pr/design-schema';

import { mapperFor, type MeshSampler, type SurfacePoint, type ZoneExtent } from './mappers.js';
import { buildSurfaceGrid } from './surface-grid.js';
import type { MeshIndex } from './mesh-index.js';
import { cross, dot, normalize, orthogonalize, scale, sub } from './vec.js';

/**
 * The decorated zone as a real, dense surface (F-PREV-06, 24-displaced-preview.md).
 *
 * A grid over zone space, mapped to the part through the same `mapperFor` the 2D editor places
 * artwork with. The height layer then displaces it along the normals stored here, in a vertex
 * shader — so this runs once per zone and resolution, and never on a placement change.
 *
 * No three.js and no DOM. The viewport adapts the arrays to a `BufferGeometry`; the tests read them
 * directly.
 */

export interface PatchResolution {
  segmentsX: number;
  segmentsY: number;
  /** Millimetres between adjacent vertices. The scale below which the shader takes over. */
  spacingMm: { x: number; y: number };
}

export interface PatchResolutionOptions {
  /** Quad budget for this device, from the quality level. */
  targetQuads: number;
  /** One height-texture texel. Subdividing finer than the signal resolves nothing. */
  minSpacingMm?: number;
  /** Hard ceiling per axis, whatever the budget says. */
  maxSegments?: number;
  /** Floor per axis, so a sliver of a zone still has a surface. */
  minSegments?: number;
}

export const PATCH_MAX_SEGMENTS = 1024;
const PATCH_MIN_SEGMENTS = 4;

/**
 * Turn a quad budget into a grid.
 *
 * Cells are kept square — a grid stretched along one axis wastes vertices on the axis that did not
 * need them and under-resolves the one that did — so the split follows the zone's aspect ratio.
 * Two clamps then apply, and either may bind: the texel floor (nothing to resolve below it) and the
 * per-axis ceiling (index buffers and upload time).
 */
export function patchResolution(
  extent: ZoneExtent,
  options: PatchResolutionOptions,
): PatchResolution {
  const maxSegments = options.maxSegments ?? PATCH_MAX_SEGMENTS;
  const minSegments = options.minSegments ?? PATCH_MIN_SEGMENTS;
  const aspect = extent.w / Math.max(1e-6, extent.h);

  const fromBudget = Math.sqrt(Math.max(1, options.targetQuads) / Math.max(1e-6, aspect));
  let segmentsY = Math.round(fromBudget);
  let segmentsX = Math.round(fromBudget * aspect);

  if (options.minSpacingMm && options.minSpacingMm > 0) {
    segmentsX = Math.min(segmentsX, Math.ceil(extent.w / options.minSpacingMm));
    segmentsY = Math.min(segmentsY, Math.ceil(extent.h / options.minSpacingMm));
  }

  segmentsX = clamp(segmentsX, minSegments, maxSegments);
  segmentsY = clamp(segmentsY, minSegments, maxSegments);

  return {
    segmentsX,
    segmentsY,
    spacingMm: { x: extent.w / segmentsX, y: extent.h / segmentsY },
  };
}

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

export interface ZonePatch {
  /** 3 per vertex: world millimetres, before any displacement. */
  position: Float32Array;
  /** 3 per vertex: unit normals, and the direction the height layer displaces along. */
  normal: Float32Array;
  /** 3 per vertex: the world direction of zone +x, for the residual normal perturbation. */
  tangent: Float32Array;
  /** 2 per vertex: the base mesh's own UV, so substrate textures tile across the patch border. */
  uv: Float32Array;
  /** 2 per vertex: into the height and ink layers, with the zone-to-canvas v flip already applied. */
  zoneUv: Float32Array;
  /**
   * 1 per vertex: 1 where the part has surface under this vertex, 0 where it does not.
   *
   * Interpolated across a boundary cell and thresholded in the fragment shader, so the patch ends
   * on a smooth line halfway between the last supported vertex and the first unsupported one
   * rather than on the cell boundary. Triangle clipping alone can only work in whole cells, and a
   * whole cell of overhang scallops the rim of a round face visibly.
   */
  support: Float32Array;
  index: Uint32Array;
  resolution: PatchResolution;
  vertexCount: number;
  triangleCount: number;
  /** How many vertices fell back to the zone frame because the mesh could not be sampled. */
  fallbackVertices: number;
  /**
   * Triangles dropped because the part has no surface under them.
   *
   * A zone is a rectangle; the surface it is authored on very often is not. The fixture closure's
   * top face is a 38 mm disc carrying a 30 mm square zone, so the square's corners sit 2 mm past
   * the rim — and a patch that drew them hung four flaps of plastic off the edge of the product.
   */
  clippedTriangles: number;
}

export interface BuildZonePatchOptions {
  /**
   * The loaded mesh.
   *
   * Needed outright by `uv_rect` and `flat_panel` zones, which are defined in its UV space; used by
   * `conformal` zones to find the real surface under the frame; used by every zone type to recover
   * the base mesh's UVs so tiled substrate maps do not jump at the patch border; and used to clip
   * the grid to where the part actually is.
   */
  mesh?: MeshIndex | undefined;
  /**
   * How far a grid vertex may be from the part and still be kept, in millimetres.
   *
   * Not zero: the product mesh is a tessellation, so it sits inside the analytic surface the zone
   * frame describes by up to its own chord error. Too small and the patch develops holes wherever
   * the mesh is coarse; too large and the corners come back. A fifth of a millimetre is well above
   * any LOD's deflection and well below the millimetres a zone corner overhangs by.
   */
  supportToleranceMm?: number;
}

export const DEFAULT_SUPPORT_TOLERANCE_MM = 0.2;

/**
 * How closely the part's surface must face the way the patch does to count as supporting it.
 *
 * 0.5 is sixty degrees, and it is the number the zone shader already uses to decide which
 * fragments a planar zone owns. Matching it is not a coincidence worth breaking: the patch covers
 * exactly what the base material discards, so the two have to draw the boundary the same way.
 */
/**
 * How parallel the surface must be for a zone to own it.
 *
 * A planar zone is authored on something flat, so the surface under it should be *parallel* to the
 * frame — not merely pointing the same general way. Sixty degrees is not flat: a closure's fillet
 * rolls from the top face to the skirt inside 1.2 mm and most of it clears sixty, so the patch laid
 * a sheet over the rounded rim and the polygon offset that keeps it out of a z-fight then drew that
 * sheet *in front of* the part. On a 30 mm square over a 38 mm disc only the corners reach that far,
 * which is why it showed up as four tabs at 45/135/225/315 degrees and nowhere else.
 *
 * A conformal zone means the opposite by the same rectangle: the frame aims the artwork and the
 * surface is expected to curve away from it, so ten degrees would reject the far side of the very
 * thing the zone exists to decorate.
 *
 * These are the numbers `zone-material.ts` gives its shaders. They live here because the patch's
 * own support test has to agree with them — when it did not, the base stopped claiming the fillet
 * and the patch went on covering it.
 */
export const PLANAR_ZONE_ALIGNMENT = 0.985;
export const CONFORMAL_ZONE_ALIGNMENT = 0.5;

/** The alignment floor for a zone, by type. */
export function zoneAlignmentMin(zone: DecorationZoneDef): number {
  return zone.type === 'conformal' ? CONFORMAL_ZONE_ALIGNMENT : PLANAR_ZONE_ALIGNMENT;
}

export class ZonePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZonePatchError';
  }
}

/** Zone types whose surface is analytic, and so need no mesh to build a patch. */
export function zoneSupportsPatch(zone: DecorationZoneDef, hasMesh: boolean): boolean {
  switch (zone.type) {
    case 'planar':
    case 'cylindrical':
    case 'conformal':
      return true;
    case 'uv_rect':
    case 'flat_panel':
      return hasMesh;
  }
}

export function buildZonePatch(
  zone: DecorationZoneDef,
  resolution: PatchResolution,
  options: BuildZonePatchOptions = {},
): ZonePatch {
  const mesh = options.mesh;
  const supportToleranceMm = options.supportToleranceMm ?? DEFAULT_SUPPORT_TOLERANCE_MM;
  const supportAlignment = zoneAlignmentMin(zone);
  if (!zoneSupportsPatch(zone, Boolean(mesh?.hasUvs))) {
    throw new ZonePatchError(`zone "${zone.key}" (${zone.type}) needs a mesh with UVs to build a patch`);
  }

  const extent = zoneExtentMm(zone);
  const mapper = mapperFor(zone, mesh as MeshSampler | undefined);
  const sample = surfaceSampler(zone, mapper.toWorld, mesh);

  const { segmentsX, segmentsY } = resolution;

  /*
   * A conformal zone gets its nodes by walking the part, not by projecting onto it.
   *
   * Projection spaces the grid evenly across the *frame*, which is only the same thing as evenly
   * across the surface while the surface stays parallel to the frame. On the flank of an oval
   * bottle it is not: measured on a 30x45x20 ellipsoid, a 40 mm zone projects across 79 mm of
   * bottle, and past the silhouette the ray stops finding surface at all. Walking spends a true
   * millimetre per millimetre and keeps going round the curve.
   */
  const walked =
    zone.type === 'conformal' && mesh
      ? buildSurfaceGrid(mesh, {
          originMm: zone.frame.originMm,
          normal: zone.frame.normal,
          tangent: zone.frame.tangent,
          widthMm: extent.w,
          heightMm: extent.h,
          segmentsX,
          segmentsY,
          maxProjectionDepthMm: zone.frame.maxProjectionDepthMm,
        })
      : null;
  const columns = segmentsX + 1;
  const rows = segmentsY + 1;
  const vertexCount = columns * rows;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const tangent = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const zoneUv = new Float32Array(vertexCount * 2);
  // One entry per vertex rather than a Set: this is read once per triangle corner, and it is also
  // handed to the GPU as an attribute, so it may as well be the buffer from the start.
  const support = new Float32Array(vertexCount).fill(1);
  let fallbackVertices = 0;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const u = i / segmentsX;
      const v = j / segmentsY;
      const zonePoint: Vec2 = { x: (u - 0.5) * extent.w, y: (v - 0.5) * extent.h };
      const node = j * columns + i;
      const { point, fellBack } = walked
        ? {
            point: {
              position: [walked.position[node * 3]!, walked.position[node * 3 + 1]!, walked.position[node * 3 + 2]!] as Vec3,
              normal: [walked.normal[node * 3]!, walked.normal[node * 3 + 1]!, walked.normal[node * 3 + 2]!] as Vec3,
              tangent: [walked.tangent[node * 3]!, walked.tangent[node * 3 + 1]!, walked.tangent[node * 3 + 2]!] as Vec3,
            },
            fellBack: walked.support[node] === 0,
          }
        : sample(zonePoint);
      if (fellBack) fallbackVertices++;

      const vertex = j * columns + i;
      write3(position, vertex, point.position);
      write3(normal, vertex, point.normal);
      write3(tangent, vertex, orthogonalize(point.tangent, point.normal));

      // Zone space is +y up; the zone canvas is +y down. The base material does this flip itself
      // when it derives UVs from a world position — the patch bakes it in once, here.
      zoneUv[vertex * 2] = u;
      zoneUv[vertex * 2 + 1] = 1 - v;

      /*
       * One question to the mesh, two answers out of it: the UV the substrate tiles by, and
       * whether the part has surface here that this patch is entitled to cover.
       *
       * "Near" is not enough on its own. A vertex a hair past the rim of a closure's top face is
       * within a fraction of a millimetre of the *skirt*, which runs down at right angles to it —
       * so proximity alone lets the patch lay a flat sheet over the rounded edge of the part and
       * shade it as though it were the top. Requiring the surface to face roughly the same way is
       * the same rule the base material applies when it decides what is inside the zone, which is
       * what keeps the patch and the hole it fills agreeing about where the zone ends.
       */
      const probe = mesh ? mesh.probeNear(point.position, supportToleranceMm) : null;
      if (mesh && (!probe || dot(probe.normal, point.normal) < supportAlignment)) {
        support[vertex] = 0;
      }

      const meshUv = mapper.toUv(zonePoint) ?? probe?.uv ?? null;
      uv[vertex * 2] = meshUv ? meshUv.x : u;
      uv[vertex * 2 + 1] = meshUv ? meshUv.y : 1 - v;
    }
  }

  // Two triangles per cell, wound so the face normal agrees with the vertex normals. Every zone
  // type gives a right-handed (tangent, bitangent, normal) frame — planar sets
  // bitangent = cross(normal, tangent), and the cylindrical frame satisfies
  // cross(tangent, axis) = radial — so one winding serves all of them. A test asserts it rather
  // than trusting the derivation.
  const full = new Uint32Array(segmentsX * segmentsY * 6);
  let out = 0;
  let clippedTriangles = 0;

  const emit = (a: number, b: number, c: number): void => {
    /*
     * One supported corner is enough to keep a triangle, and the choice is not close.
     *
     * The base material punches its hole from the zone rectangle, which does not know the part's
     * outline — so along the arc where a round face crosses a square zone, requiring all three
     * corners leaves a cell-wide strip that the base has discarded and the patch has not covered:
     * a slot you can see the background through. Keeping the cell instead overhangs the rim by at
     * most one cell, which at these spacings is a fraction of a pixel. A ragged edge beats a hole.
     */
    if (!support[a] && !support[b] && !support[c]) {
      clippedTriangles++;
      return;
    }
    full[out++] = a;
    full[out++] = b;
    full[out++] = c;
  };

  for (let j = 0; j < segmentsY; j++) {
    for (let i = 0; i < segmentsX; i++) {
      const v00 = j * columns + i;
      const v10 = v00 + 1;
      const v01 = v00 + columns;
      const v11 = v01 + 1;
      emit(v00, v10, v11);
      emit(v00, v11, v01);
    }
  }

  return {
    position,
    normal,
    tangent,
    uv,
    zoneUv,
    support,
    // Trimmed rather than handed over at full length: three.js draws the whole buffer unless it is
    // told otherwise, and a tail of zeroes is a fan of degenerate triangles at the first vertex.
    index: out === full.length ? full : full.slice(0, out),
    resolution,
    vertexCount,
    triangleCount: out / 3,
    fallbackVertices,
    clippedTriangles,
  };
}

/**
 * Zone point → surface point, with the conformal case doing what its name promises.
 *
 * `mapperFor` treats a conformal zone as a planar one, because everything above it only ever needed
 * a frame. A patch is different: it is geometry, and geometry laid on the frame instead of on the
 * part would float above a curved surface by however much the two diverge. So a conformal zone
 * fires a ray from above its frame and takes the first surface it finds, falling back to the frame
 * where the ray misses — which is exactly the behaviour the shader already assumes.
 */
function surfaceSampler(
  zone: DecorationZoneDef,
  toWorld: (p: Vec2) => SurfacePoint,
  mesh: MeshIndex | undefined,
): (p: Vec2) => { point: SurfacePoint; fellBack: boolean } {
  if (zone.type !== 'conformal' || !mesh) {
    return (p) => ({ point: toWorld(p), fellBack: false });
  }

  const depth = zone.frame.maxProjectionDepthMm;
  const frameNormal = normalize(zone.frame.normal);

  return (p) => {
    const frame = toWorld(p);
    // Start clear of the surface and look back along the frame normal, so a part that bulges
    // towards the frame is still hit rather than started inside.
    const origin = add(frame.position, scale(frameNormal, depth));
    const hit = mesh.projectAlong(origin, scale(frameNormal, -1), depth * 2);
    if (!hit) return { point: frame, fellBack: true };

    // Keep the zone's own tangent direction: the artwork's "up" is defined by the frame, not by
    // however the mesh happens to be parameterised where the ray landed.
    return {
      point: {
        position: hit.position,
        normal: dot(hit.normal, frameNormal) < 0 ? scale(hit.normal, -1) : hit.normal,
        tangent: frame.tangent,
      },
      fellBack: false,
    };
  };
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function write3(target: Float32Array, vertex: number, value: Vec3): void {
  target[vertex * 3] = value[0];
  target[vertex * 3 + 1] = value[1];
  target[vertex * 3 + 2] = value[2];
}

/**
 * The face normal of one triangle, for verifying winding.
 *
 * Exported because it is the only honest way to test the index order: derive the normal from the
 * positions and check it agrees with the normals the mapper produced.
 */
export function faceNormal(patch: ZonePatch, triangle: number): Vec3 {
  const at = (k: number): Vec3 => {
    const v = patch.index[triangle * 3 + k]!;
    return [patch.position[v * 3]!, patch.position[v * 3 + 1]!, patch.position[v * 3 + 2]!];
  };
  const [a, b, c] = [at(0), at(1), at(2)];
  return normalize(cross(sub(b, a), sub(c, a)));
}

/** The vertex normal a triangle's first corner carries. */
export function cornerNormal(patch: ZonePatch, triangle: number): Vec3 {
  const v = patch.index[triangle * 3]!;
  return [patch.normal[v * 3]!, patch.normal[v * 3 + 1]!, patch.normal[v * 3 + 2]!];
}
