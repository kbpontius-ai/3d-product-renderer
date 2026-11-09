import type { DecorationZoneDef, Vec2, Vec3 } from '@pr/design-schema';
import { zoneExtentMm } from '@pr/design-schema';
import {
  add,
  anyPerpendicular,
  cross,
  DEG2RAD,
  dot,
  normalize,
  orthogonalize,
  RAD2DEG,
  scale,
  sub,
  wrapAngle,
} from './vec.js';

/**
 * Zone space is the 2D millimetre system the user works in: origin at the zone centre, +x right,
 * +y up, measured on the UNROLLED surface. Every zone type maps to it; nothing above this layer
 * knows whether a product is a cap, a bottle, or a carton.
 */
export interface SurfacePoint {
  position: Vec3;
  normal: Vec3;
  /** World direction corresponding to +x in zone space, used for normal perturbation. */
  tangent: Vec3;
}

export interface ZoneExtent {
  w: number;
  h: number;
  safeMarginMm: number;
}

/** Optional mesh access, needed only by zone types defined in UV space. */
export interface MeshSampler {
  sampleByUv(uv: Vec2): SurfacePoint;
  uvMetricAt(uv: Vec2): number;
}

export interface ZoneMapper {
  readonly type: DecorationZoneDef['type'];
  extent(): ZoneExtent;
  toWorld(p: Vec2): SurfacePoint;
  fromWorld(p: Vec3): Vec2;
  toUv(p: Vec2): Vec2 | null;
  /**
   * Local distortion factor: 1 means a millimetre in zone space is a millimetre on the part.
   * Planar and cylindrical unrollings are isometric; authored UV islands may stretch, which is why
   * pack ingestion measures this and rejects zones that would make the on-screen numbers lie.
   */
  metric(p: Vec2): number;
}

export class ZoneMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneMappingError';
  }
}

export function mapperFor(zone: DecorationZoneDef, mesh?: MeshSampler): ZoneMapper {
  const extent = () => zoneExtentMm(zone);

  switch (zone.type) {
    case 'planar':
    case 'conformal': {
      const n = normalize(zone.frame.normal);
      const t = orthogonalize(zone.frame.tangent, n);
      const b = cross(n, t);
      const origin = zone.frame.originMm;
      const uvRect = zone.type === 'planar' ? zone.uvRect : undefined;

      return {
        type: zone.type,
        extent,
        toWorld: (p) => ({
          position: add(origin, add(scale(t, p.x), scale(b, p.y))),
          normal: n,
          tangent: t,
        }),
        fromWorld: (world) => {
          const d = sub(world, origin);
          return { x: dot(d, t), y: dot(d, b) };
        },
        toUv: uvRect ? (p) => uvFromRect(p, extent(), uvRect) : () => null,
        metric: () => 1,
      };
    }

    case 'cylindrical': {
      const a = normalize(zone.frame.axisDir);
      const u = anyPerpendicular(a);
      const v = cross(a, u);
      const { radiusMm, centerAngleDeg, centerHeightMm, axisOriginMm } = zone.frame;

      return {
        type: 'cylindrical',
        extent,
        toWorld: (p) => {
          const theta = centerAngleDeg * DEG2RAD + p.x / radiusMm; // arc length -> angle
          const radial = add(scale(u, Math.cos(theta)), scale(v, Math.sin(theta)));
          const height = centerHeightMm + p.y;
          return {
            position: add(axisOriginMm, add(scale(a, height), scale(radial, radiusMm))),
            normal: radial,
            tangent: add(scale(u, -Math.sin(theta)), scale(v, Math.cos(theta))),
          };
        },
        fromWorld: (world) => {
          const d = sub(world, axisOriginMm);
          const height = dot(d, a);
          const theta = Math.atan2(dot(d, v), dot(d, u));
          return {
            x: wrapAngle(theta - centerAngleDeg * DEG2RAD) * radiusMm,
            y: height - centerHeightMm,
          };
        },
        toUv: () => null, // shading samples the mesh's own UVs
        metric: () => 1, // unrolling a cylinder preserves lengths exactly
      };
    }

    case 'uv_rect':
    case 'flat_panel': {
      const uvRect = zone.uvRect;
      return {
        type: zone.type,
        extent,
        toWorld: (p) => {
          if (!mesh) throw new ZoneMappingError(`zone "${zone.key}" needs a mesh sampler`);
          return mesh.sampleByUv(uvFromRect(p, extent(), uvRect));
        },
        fromWorld: () => {
          throw new ZoneMappingError(`zone "${zone.key}" cannot invert world positions directly`);
        },
        toUv: (p) => uvFromRect(p, extent(), uvRect),
        metric: (p) => (mesh ? mesh.uvMetricAt(uvFromRect(p, extent(), uvRect)) : 1),
      };
    }
  }
}

/** Zone-space millimetres -> normalized UV inside the zone's authored rectangle. */
export function uvFromRect(
  p: Vec2,
  extent: ZoneExtent,
  rect: { u0: number; v0: number; u1: number; v1: number },
): Vec2 {
  const tx = p.x / extent.w + 0.5;
  const ty = p.y / extent.h + 0.5;
  return {
    x: rect.u0 + tx * (rect.u1 - rect.u0),
    y: rect.v0 + ty * (rect.v1 - rect.v0),
  };
}

/** Wrap angle covered by a width in zone space, for cylindrical legibility warnings. */
export function wrapAngleDeg(zone: DecorationZoneDef, widthMm: number): number | null {
  if (zone.type !== 'cylindrical') return null;
  return (widthMm / zone.frame.radiusMm) * RAD2DEG;
}
