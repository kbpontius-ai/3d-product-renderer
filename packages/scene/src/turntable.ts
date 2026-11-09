import type { OrientationFrame } from '@pr/design-schema';
import { orientCamera } from './orientation.js';
import type { BoundingSphere } from './bounds.js';
import { DEFAULT_SENSOR_MM, orbitPosition, type ResolvedCamera } from './camera.js';

/**
 * The turntable is ONE pre-planned orbit shared by every product (F-REND-10). Its radius comes
 * from the bounding sphere, so a cap and a carton both sit correctly in frame with no per-product
 * configuration and no extra authoring in a Product Pack.
 */
export interface OrbitSpec {
  elevationDeg: number;
  radiusScale: number;
  startAzimuthDeg: number;
  loop: boolean;
}

export const DEFAULT_ORBIT: OrbitSpec = {
  elevationDeg: 18,
  radiusScale: 2.6,
  startAzimuthDeg: 0,
  loop: true,
};

export interface TurntableOptions {
  fps: number;
  durationSec: number;
  focalMm?: number;
  orientation?: OrientationFrame;
}

export const turntableFrameCount = (o: TurntableOptions): number =>
  Math.max(1, Math.round(o.fps * o.durationSec));

/**
 * Camera for frame `index`. A looping turntable never repeats the first frame at the end, so the
 * encoded video joins seamlessly; a non-looping one ends exactly one full revolution later.
 */
export function turntableCamera(
  sphere: BoundingSphere,
  orbit: OrbitSpec,
  options: TurntableOptions,
  index: number,
): ResolvedCamera {
  const frames = turntableFrameCount(options);
  const denominator = orbit.loop ? frames : Math.max(1, frames - 1);
  const azimuthDeg = orbit.startAzimuthDeg + (360 * index) / denominator;

  return orientCamera(
    {
      positionMm: orbitPosition(sphere, azimuthDeg, orbit.elevationDeg, orbit.radiusScale),
      targetMm: sphere.centerMm,
      upMm: [0, 1, 0],
      focalMm: options.focalMm ?? 85,
      sensorMm: DEFAULT_SENSOR_MM,
    },
    sphere.centerMm,
    options.orientation,
  );
}

export function turntablePath(
  sphere: BoundingSphere,
  orbit: OrbitSpec,
  options: TurntableOptions,
): ResolvedCamera[] {
  return Array.from({ length: turntableFrameCount(options) }, (_, i) =>
    turntableCamera(sphere, orbit, options, i),
  );
}
