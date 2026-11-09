import { z } from 'zod';

export const ArtworkErrorCode = z.enum([
  'not_svg',
  'too_large',
  'parse_failed',
  'contains_external_reference',
  'text_not_outlined',
  'empty_after_normalize',
  'complexity_exceeded',
  'unsupported_units',
]);
export type ArtworkErrorCode = z.infer<typeof ArtworkErrorCode>;

export const ArtworkWarnCode = z.enum([
  'open_paths',
  'thin_strokes',
  'gradients_flattened',
  'filters_dropped',
  'self_intersections',
  'aspect_extreme',
  'low_contrast_for_emboss',
]);
export type ArtworkWarnCode = z.infer<typeof ArtworkWarnCode>;

export const ArtworkStats = z.object({
  pathCount: z.number().int().nonnegative(),
  nodeCount: z.number().int().nonnegative(),
  naturalSizeMm: z.object({ w: z.number().positive(), h: z.number().positive() }),
  contentBbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  /** Thinnest stroke/feature at natural size; null when it could not be measured. */
  minStrokeMm: z.number().nullable(),
  /** Fraction of the artwork bounding box covered by ink. */
  coverage: z.number().min(0).max(1),
  hasText: z.boolean(),
  hasGradients: z.boolean(),
  hasClipPaths: z.boolean(),
});
export type ArtworkStats = z.infer<typeof ArtworkStats>;

export const ArtworkReport = z.object({
  pipelineVersion: z.string().min(1),
  status: z.enum(['ready', 'rejected']),
  errors: z.array(
    z.object({ code: ArtworkErrorCode, message: z.string(), hint: z.string().optional() }),
  ),
  warnings: z.array(
    z.object({
      code: ArtworkWarnCode,
      message: z.string(),
      detail: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  stats: ArtworkStats,
});
export type ArtworkReport = z.infer<typeof ArtworkReport>;

export const ArtworkEdit = z.object({
  versionId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  widthMm: z.number().finite().min(0.01).max(1000),
  heightMm: z.number().finite().min(0.01).max(1000),
  rotationDeg: z.number().finite().min(-360).max(360),
  flipX: z.boolean(),
  flipY: z.boolean(),
});
export type ArtworkEdit = z.infer<typeof ArtworkEdit>;
