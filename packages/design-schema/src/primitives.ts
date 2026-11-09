import { z } from 'zod';

/** Hex color, always 6 digits, always uppercase-insensitive. Alpha is never encoded here. */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

/** 2D point in zone space. Always millimetres (see docs/15-placement-math.md). */
export const Vec2 = z.object({ x: z.number().finite(), y: z.number().finite() });

/** 3D vector, tuple-encoded to keep documents compact. World units are millimetres. */
export const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/** Normalized texture-space rectangle, v increasing upward. */
export const UvRect = z.object({
  u0: z.number().min(0).max(1),
  v0: z.number().min(0).max(1),
  u1: z.number().min(0).max(1),
  v1: z.number().min(0).max(1),
});

export const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'expected semver');
export const Digest = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
export const Key = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'expected lowercase key');

export type HexColor = z.infer<typeof HexColor>;
export type Vec2 = z.infer<typeof Vec2>;
export type Vec3 = z.infer<typeof Vec3>;
export type UvRect = z.infer<typeof UvRect>;
