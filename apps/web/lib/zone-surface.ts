import { zoneExtentMm, type DecorationZoneDef, type Vec3 } from '@pr/design-schema';
import {
  add,
  buildZonePatch,
  dot,
  normalize,
  patchResolution,
  scale,
  sub,
  length,
  type MeshIndex,
  type SurfacePoint,
  type ZonePatch,
} from '@pr/placement';
import type { SurfaceReport } from './zone-authoring';

export interface ZoneSurface {
  patch: ZonePatch;
  boundary: Vec3[][];
  safe: Vec3[][];
  centre: SurfacePoint | null;
  labelAt: Vec3 | null;
  report: SurfaceReport;
}

export function buildZoneSurface(
  zone: Extract<DecorationZoneDef, { type: 'conformal' }>,
  mesh: MeshIndex,
): ZoneSurface {
  const extent = zoneExtentMm(zone);
  const patch = buildZonePatch(
    zone,
    patchResolution(extent, { targetQuads: 4096, maxSegments: 128 }),
    { mesh },
  );
  // The editor shader masks partial support; this plain preview has no shader mask.
  const supported: number[] = [];
  for (let i = 0; i < patch.index.length; i += 3) {
    const triangle = [patch.index[i]!, patch.index[i + 1]!, patch.index[i + 2]!];
    if (triangle.every((vertex) => patch.support[vertex]! >= 0.5)) supported.push(...triangle);
  }
  patch.index = Uint32Array.from(supported);
  patch.triangleCount = supported.length / 3;
  const { segmentsX, segmentsY } = patch.resolution;
  const columns = segmentsX + 1;
  const sample = (x: number, y: number): SurfacePoint | null => {
    const gx = Math.max(0, Math.min(segmentsX, (x / extent.w + 0.5) * segmentsX));
    const gy = Math.max(0, Math.min(segmentsY, (y / extent.h + 0.5) * segmentsY));
    const col = Math.min(segmentsX - 1, Math.floor(gx));
    const row = Math.min(segmentsY - 1, Math.floor(gy));
    const tx = gx - col,
      ty = gy - row;
    const nodes = [
      row * columns + col,
      row * columns + col + 1,
      (row + 1) * columns + col,
      (row + 1) * columns + col + 1,
    ];
    const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    if (nodes.some((node, i) => weights[i]! > 1e-8 && patch.support[node]! < 0.5)) return null;
    const blend = (values: Float32Array): Vec3 =>
      [0, 1, 2].map((axis) =>
        nodes.reduce((sum, node, i) => sum + values[node * 3 + axis]! * weights[i]!, 0),
      ) as Vec3;
    return {
      position: blend(patch.position),
      normal: normalize(blend(patch.normal)),
      tangent: normalize(blend(patch.tangent)),
    };
  };
  const loop = (halfW: number, halfH: number): Vec3[][] => {
    const corners = [
      [-halfW, -halfH],
      [halfW, -halfH],
      [halfW, halfH],
      [-halfW, halfH],
    ];
    const runs: Vec3[][] = [];
    let run: Vec3[] = [];
    // Split at unsupported samples rather than drawing a line across a mesh gap.
    for (let edge = 0; edge < 4; edge++) {
      const a = corners[edge]!,
        b = corners[(edge + 1) % 4]!;
      for (let i = 0; i <= 64; i++) {
        const p = sample(a[0]! + ((b[0]! - a[0]!) * i) / 64, a[1]! + ((b[1]! - a[1]!) * i) / 64);
        if (p) run.push(add(p.position, scale(p.normal, 0.08)));
        else {
          if (run.length > 1) runs.push(run);
          run = [];
        }
      }
    }
    if (run.length > 1) runs.push(run);
    return runs;
  };
  const centre = sample(0, 0);
  const nearest = mesh.nearestSurface(zone.frame.originMm, zone.frame.maxProjectionDepthMm);
  const cornersOff = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].filter(([x, y]) => !sample((x! * extent.w) / 2, (y! * extent.h) / 2)).length;
  const unsupportedVertices = Array.from(patch.support).filter((value) => value < 0.5).length;
  return {
    patch,
    centre,
    boundary: loop(extent.w / 2, extent.h / 2),
    safe: loop(
      Math.max(0, extent.w / 2 - extent.safeMarginMm),
      Math.max(0, extent.h / 2 - extent.safeMarginMm),
    ),
    labelAt: sample(0, extent.h / 2)?.position ?? centre?.position ?? null,
    report: {
      centreMm: centre && nearest ? length(sub(centre.position, nearest.position)) : null,
      cornersOff,
      unsupportedVertices,
      surfaceVertices: patch.vertexCount,
      facesInto: nearest
        ? dot(normalize(nearest.normal), normalize(zone.frame.normal)) < -0.5
        : false,
    },
  };
}
