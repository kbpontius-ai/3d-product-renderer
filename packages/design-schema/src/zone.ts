import { z } from 'zod';
import { Key, UvRect, Vec3 } from './primitives.js';

export const FinishKind = z.enum(['emboss', 'deboss', 'print']);
export type FinishKind = z.infer<typeof FinishKind>;

export const ZoneConstraints = z.object({
  finishes: z.array(FinishKind).min(1),
  /** Maximum achievable relief for this zone, from tooling limits. */
  maxDepthMm: z.number().positive().default(0.6),
  /** Thinnest artwork feature the process can reproduce. */
  minStrokeMm: z.number().positive().default(0.25),
  /** Fraction of zone area artwork may cover before it is flagged. */
  maxCoverage: z.number().min(0).max(1).default(0.9),
  /** Wrap angle (deg) beyond which a cylindrical placement is hard to read in one view. */
  wrapWarnDeg: z.number().positive().default(120),
});
export type ZoneConstraints = z.infer<typeof ZoneConstraints>;

const commonSize = {
  safeMarginMm: z.number().min(0).default(1),
};

const PlanarZone = z.object({
  type: z.literal('planar'),
  key: Key,
  name: z.string().min(1),
  frame: z.object({ originMm: Vec3, normal: Vec3, tangent: Vec3 }),
  sizeMm: z.object({ width: z.number().positive(), height: z.number().positive(), ...commonSize }),
  uvRect: UvRect.optional(),
  constraints: ZoneConstraints,
  materialSlotKey: Key.optional(),
});

const CylindricalZone = z.object({
  type: z.literal('cylindrical'),
  key: Key,
  name: z.string().min(1),
  frame: z.object({
    axisOriginMm: Vec3,
    axisDir: Vec3,
    radiusMm: z.number().positive(),
    centerAngleDeg: z.number(),
    centerHeightMm: z.number(),
  }),
  sizeMm: z.object({
    arcWidthMm: z.number().positive(),
    height: z.number().positive(),
    ...commonSize,
  }),
  constraints: ZoneConstraints,
  materialSlotKey: Key.optional(),
});

const UvRectZone = z.object({
  type: z.literal('uv_rect'),
  key: Key,
  name: z.string().min(1),
  uvSet: z.string().default('decor'),
  uvRect: UvRect,
  sizeMm: z.object({ width: z.number().positive(), height: z.number().positive(), ...commonSize }),
  constraints: ZoneConstraints,
  materialSlotKey: Key.optional(),
});

const ConformalZone = z.object({
  type: z.literal('conformal'),
  key: Key,
  name: z.string().min(1),
  frame: z.object({
    originMm: Vec3,
    normal: Vec3,
    tangent: Vec3,
    maxProjectionDepthMm: z.number().positive(),
  }),
  sizeMm: z.object({ width: z.number().positive(), height: z.number().positive(), ...commonSize }),
  constraints: ZoneConstraints,
  materialSlotKey: Key.optional(),
});

/** v2: a flat panel of a dieline (carton), printed flat and folded afterwards. */
const FlatPanelZone = z.object({
  type: z.literal('flat_panel'),
  key: Key,
  name: z.string().min(1),
  panelId: z.string().min(1),
  uvRect: UvRect,
  sizeMm: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    safeMarginMm: z.number().min(0).default(3),
  }),
  constraints: ZoneConstraints,
  materialSlotKey: Key.optional(),
});

export const DecorationZoneDef = z.discriminatedUnion('type', [
  PlanarZone,
  CylindricalZone,
  UvRectZone,
  ConformalZone,
  FlatPanelZone,
]);
export type DecorationZoneDef = z.infer<typeof DecorationZoneDef>;
export type ZoneType = DecorationZoneDef['type'];

/** Width/height of a zone in millimetres, regardless of zone type. */
export function zoneExtentMm(zone: DecorationZoneDef): {
  w: number;
  h: number;
  safeMarginMm: number;
} {
  if (zone.type === 'cylindrical') {
    return {
      w: zone.sizeMm.arcWidthMm,
      h: zone.sizeMm.height,
      safeMarginMm: zone.sizeMm.safeMarginMm,
    };
  }
  return { w: zone.sizeMm.width, h: zone.sizeMm.height, safeMarginMm: zone.sizeMm.safeMarginMm };
}
