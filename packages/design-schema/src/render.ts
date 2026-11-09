import { z } from 'zod';
import { OrientationFrame } from './orientation.js';
import { Digest, Key, Vec3 } from './primitives.js';
import { Camera, DesignDocument } from './design.js';
import { MaterialDefinition } from './material.js';
import { DecorationZoneDef } from './zone.js';

export const ImageOutput = z.object({
  kind: z.literal('image'),
  widthPx: z.number().int().min(256).max(8192),
  heightPx: z.number().int().min(256).max(8192),
  format: z.enum(['png8', 'png16', 'jpeg', 'webp']),
  alpha: z.boolean().default(false),
  camera: Camera,
});

/** v2 turntable: one pre-planned orbit shared by every product, derived from its bounding sphere. */
export const VideoOutput = z.object({
  kind: z.literal('video'),
  widthPx: z.number().int().min(256).max(4096),
  heightPx: z.number().int().min(256).max(4096),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
  durationSec: z.number().min(3).max(20).default(8),
  orbit: z
    .object({
      elevationDeg: z.number().default(18),
      radiusScale: z.number().positive().default(2.6),
      startAzimuthDeg: z.number().default(0),
      loop: z.boolean().default(true),
    })
    .default({ elevationDeg: 18, radiusScale: 2.6, startAzimuthDeg: 0, loop: true }),
  format: z.enum(['mp4', 'webm']).default('mp4'),
});

export const RenderQuality = z.object({
  preset: z.enum(['draft', 'standard', 'final']),
  samples: z.number().int().min(16).max(4096),
  maxBounces: z.number().int().min(2).max(24),
  denoiser: z.enum(['none', 'optix', 'oidn']),
  adaptiveThreshold: z.number().min(0).max(0.1),
  displacement: z.object({
    mode: z.enum(['bump', 'displacement']),
    dicingRate: z.number().min(0.25).max(4).default(1),
  }),
});
export type RenderQuality = z.infer<typeof RenderQuality>;

export const ResolvedArtwork = z.object({
  versionId: z.uuid(),
  heightKey: z.string().optional(),
  maskKey: z.string(),
  sdfKey: z.string(),
  sdfRangeMm: z.tuple([z.number(), z.number()]),
  mmPerPx: z.number().positive(),
  digest: Digest,
});

/** Viewer-only lighting captured at render submission, independently of the saved design. */
export const RenderLighting = z.object({
  environmentKey: Key,
  rotationDeg: z.number().finite().min(-360).max(360),
  orientation: OrientationFrame.optional(),
}).strict();
export type RenderLighting = z.infer<typeof RenderLighting>;

/** Immutable job input. `spec_hash = sha256(canonicalJson(RenderSpec))`. */
export const RenderSpec = z.object({
  specVersion: z.literal(1),
  document: DesignDocument,
  resolved: z.object({
    presentationOrientation: OrientationFrame.optional(),
    meshKey: z.string().min(1),
    meshDigest: Digest,
    /** The variant's extents in millimetres. The worker frames and lights from this. */
    bboxMm: z.tuple([Vec3, Vec3]),
    zones: z.array(DecorationZoneDef),
    artwork: z.array(ResolvedArtwork),
    materials: z.array(
      z.object({ key: Key, version: z.number().int(), definition: MaterialDefinition }),
    ),
    environment: z.object({
      key: Key,
      hdriKey: z.string().min(1),
      rotationDeg: z.number(),
      exposureEv: z.number(),
      orientation: OrientationFrame.optional(),
    }),
  }),
  outputs: z
    .array(z.discriminatedUnion('kind', [ImageOutput, VideoOutput]))
    .min(1)
    .max(16),
  quality: RenderQuality,
  seed: z.number().int(),
  renderer: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  limits: z.object({
    maxWallClockSec: z.number().int().positive(),
    maxVramMb: z.number().int().positive(),
  }),
});
export type RenderSpec = z.infer<typeof RenderSpec>;

/**
 * Quality presets (F-REND-02): samples, denoiser and displacement subdivision in one choice.
 *
 * Draft uses bump because it is for looking at; standard and final subdivide and truly displace,
 * which is what makes the relief geometry rather than a shading trick (F-REND-04).
 */
export const QUALITY_PRESETS: Record<RenderQuality['preset'], Omit<RenderQuality, 'preset'>> = {
  draft: {
    samples: 64,
    maxBounces: 4,
    denoiser: 'optix',
    adaptiveThreshold: 0.05,
    displacement: { mode: 'bump', dicingRate: 2 },
  },
  standard: {
    samples: 512,
    maxBounces: 8,
    denoiser: 'optix',
    adaptiveThreshold: 0.01,
    displacement: { mode: 'displacement', dicingRate: 1 },
  },
  final: {
    samples: 1500,
    maxBounces: 12,
    denoiser: 'oidn',
    adaptiveThreshold: 0.005,
    displacement: { mode: 'displacement', dicingRate: 0.5 },
  },
};
