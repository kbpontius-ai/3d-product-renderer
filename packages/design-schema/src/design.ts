import { z } from 'zod';
import { OrientationFrame } from './orientation.js';
import { HexColor, Key, Vec2, Vec3 } from './primitives.js';

/**
 * Placement transform, expressed in ZONE SPACE: millimetres, origin at the zone centre,
 * +x right, +y up, on the unrolled surface. See docs/15-placement-math.md.
 */
export const Transform = z.object({
  offsetMm: Vec2,
  sizeMm: z.object({ w: z.number().positive(), h: z.number().positive() }),
  rotationDeg: z.number().min(-360).max(360).default(0),
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
  /** UI state, preserved so a reopened design behaves the way the user left it. */
  lockAspect: z.boolean().default(true),
});
export type Transform = z.infer<typeof Transform>;

export const ReliefFinish = z.object({
  kind: z.enum(['emboss', 'deboss']),
  depthMm: z.number().min(0.05).max(5),
  /** Draft angle of the side wall, measured from the base surface. 90 = vertical wall. */
  bevelDeg: z.number().min(1).max(90).default(30),
  edgeRadiusMm: z.number().min(0).max(1).default(0.05),
  /** Absent = blind relief in the part's own material. */
  inkMaterialKey: Key.optional(),
  /** Tint for a filled relief (foil, hot stamp); only meaningful with `inkMaterialKey`. */
  tintHex: HexColor.optional(),
});

export const PrintFinish = z.object({
  kind: z.literal('print'),
  inkMaterialKey: Key,
  tintHex: HexColor.optional(),
  opacity: z.number().min(0).max(1).default(1),
});

export const Finish = z.discriminatedUnion('kind', [ReliefFinish, PrintFinish]);
export type Finish = z.infer<typeof Finish>;

export const Placement = z.object({
  id: z.uuid(),
  zoneKey: Key,
  artwork: z.object({ artworkId: z.uuid(), versionId: z.uuid() }),
  transform: Transform,
  finish: Finish,
  order: z.number().int().default(0),
});
export type Placement = z.infer<typeof Placement>;

export const MaterialAssignment = z.object({
  materialKey: Key,
  colorHex: HexColor.optional(),
  textureScale: z.number().positive().default(1),
  textureRotationDeg: z.number().default(0),
  overrides: z
    .object({
      roughness: z.number().min(0).max(1).optional(),
      metallic: z.number().min(0).max(1).optional(),
      clearcoat: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type MaterialAssignment = z.infer<typeof MaterialAssignment>;

export const Camera = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), presetKey: Key }),
  z.object({
    kind: z.literal('custom'),
    positionMm: Vec3,
    targetMm: Vec3,
    upMm: Vec3.default([0, 1, 0]),
    focalMm: z.number().min(8).max(400).default(85),
    sensorMm: z.number().min(4).max(70).default(36),
    fStop: z.number().min(0.7).max(32).optional(),
    focusDistanceMm: z.number().positive().optional(),
  }),
]);
export type Camera = z.infer<typeof Camera>;

export const Background = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('studio') }),
  z.object({ kind: z.literal('solid'), colorHex: HexColor }),
  z.object({ kind: z.literal('transparent') }),
]);

export const SceneSettings = z.object({
  presentationOrientationOverride: OrientationFrame.optional(),
  environmentKey: Key,
  environmentRotationDeg: z.number().default(0),
  exposureEv: z.number().min(-8).max(8).default(0),
  background: Background,
  camera: Camera,
});

export const CURRENT_SCHEMA_VERSION = 1;

export const DesignDocument = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  units: z.literal('mm'),
  product: z.object({
    packKey: Key,
    packVersion: z.string().min(1),
    productKey: Key,
    variantKey: Key,
  }),
  /** Keyed by the material slot keys the pack declares for this variant. */
  materials: z.record(Key, MaterialAssignment),
  placements: z.array(Placement).max(32),
  scene: SceneSettings,
  annotations: z.object({ note: z.string().max(2000).optional() }).default({}),
});
export type DesignDocument = z.infer<typeof DesignDocument>;
