import { z } from 'zod';
import { Vec3 } from './primitives.js';

export const OrientationFrame = z
  .object({
    version: z.literal(1),
    frontSource: Vec3,
    upSource: Vec3,
  })
  .superRefine((frame, ctx) => {
    const frontLength = Math.hypot(...frame.frontSource);
    const upLength = Math.hypot(...frame.upSource);
    const dot = frame.frontSource.reduce((sum, v, i) => sum + v * frame.upSource[i]!, 0);
    if (
      !Number.isFinite(frontLength + upLength + dot) ||
      Math.abs(frontLength - 1) > 1e-5 ||
      Math.abs(upLength - 1) > 1e-5 ||
      Math.abs(dot) > 1e-5
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Front and Up must be perpendicular unit directions.',
      });
    }
  });
export type OrientationFrame = z.infer<typeof OrientationFrame>;
export const PresentationOrientation = OrientationFrame.and(z.object({ confirmed: z.boolean() }));
export type PresentationOrientation = z.infer<typeof PresentationOrientation>;
