import { z } from 'zod';
import { PresentationOrientation } from './orientation.js';
import { Digest, Key, SemVer, Vec3 } from './primitives.js';
import { DecorationZoneDef } from './zone.js';
import { FinishFamily, MaterialDefinition } from './material.js';

export const AssetRef = z.object({
  path: z.string().min(1),
  digest: Digest.optional(),
  bytes: z.number().int().nonnegative().optional(),
});

export const CameraPreset = z.object({
  key: Key,
  label: z.string().min(1),
  /** Framing is relative to the variant's bounding sphere, so presets are product-agnostic. */
  azimuthDeg: z.number(),
  elevationDeg: z.number(),
  radiusScale: z.number().positive().default(2.4),
  focalMm: z.number().positive().default(85),
  targetOffsetMm: Vec3.default([0, 0, 0]),
});

export const MaterialSlot = z.object({
  key: Key,
  label: z.string().min(1),
  defaultMaterialKey: Key,
  /** What the part may be made of. Empty means the pack does not restrict it. */
  allowedFamilies: z.array(z.string()).default([]),
  /**
   * How it may be finished (F-MAT-03). Empty means unrestricted.
   *
   * Separate from `allowedFamilies` because the two restrict different things and a slot often
   * wants one and not the other: a closure liner is always polypropylene but may be any finish,
   * while a carton panel is always paperboard and cannot be soft-touch without a coating pass.
   */
  allowedFinishes: z.array(FinishFamily).default([]),
  colorizable: z.boolean().default(true),
});

export const ProductVariantDef = z.object({
  key: Key,
  name: z.string().min(1),
  dimensionsMm: z.object({ bbox: z.tuple([Vec3, Vec3]) }).catchall(z.number()),
  assets: z.object({
    lod0: AssetRef,
    lod1: AssetRef.optional(),
    renderMesh: AssetRef,
    thumbnail: AssetRef.optional(),
  }),
  materialSlots: z.array(MaterialSlot).min(1),
  zones: z.array(DecorationZoneDef).default([]),
  cameraPresets: z.array(CameraPreset).default([]),
  presentationOrientation: PresentationOrientation.optional(),
  capabilities: z
    .object({
      transmission: z.boolean().default(false),
      video: z.boolean().default(true),
      deformable: z.boolean().default(false),
    })
    .default({ transmission: false, video: true, deformable: false }),
});
export type ProductVariantDef = z.infer<typeof ProductVariantDef>;

export const ProductDef = z.object({
  key: Key,
  name: z.string().min(1),
  category: z.string().min(1),
  facets: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  variants: z.array(ProductVariantDef).min(1),
});

/**
 * A Product Pack is the ONLY way to add a product. No product-specific code exists in the app;
 * see docs/00-overview.md "Product-agnostic by design".
 */
export const PackManifest = z.object({
  manifestVersion: z.literal(1),
  key: Key,
  version: SemVer,
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  materials: z.array(MaterialDefinition).default([]),
  environments: z.array(Key).default([]),
  products: z.array(ProductDef).min(1),
});
export type PackManifest = z.infer<typeof PackManifest>;
