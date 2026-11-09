import type { Camera, Vec3 } from '@pr/design-schema';
import { orientCamera } from './orientation.js';
import type { OrientationFrame } from '@pr/design-schema';
import type { BoundingSphere } from './bounds.js';

const DEG2RAD = Math.PI / 180;

export interface CameraPresetDef {
  key: string;
  label: string;
  azimuthDeg: number;
  elevationDeg: number;
  radiusScale: number;
  focalMm: number;
  targetOffsetMm: Vec3;
}

export interface ResolvedCamera {
  positionMm: Vec3;
  targetMm: Vec3;
  upMm: Vec3;
  focalMm: number;
  sensorMm: number;
  fStop?: number;
  focusDistanceMm?: number;
}

/** Full-frame sensor. Both renderers are configured to fit the horizontal dimension. */
export const DEFAULT_SENSOR_MM = 36;
export const SENSOR_WIDTH_MM = 36;
export const SENSOR_HEIGHT_MM = 24;

/** Field of view across a given sensor dimension. Preview and render use this same formula. */
export const fovRadFromFocal = (focalMm: number, sensorMm = DEFAULT_SENSOR_MM): number =>
  2 * Math.atan(sensorMm / (2 * focalMm));

export const fovDegFromFocal = (focalMm: number, sensorMm = DEFAULT_SENSOR_MM): number =>
  (fovRadFromFocal(focalMm, sensorMm) * 180) / Math.PI;

export const focalFromFovDeg = (fovDeg: number, sensorMm = DEFAULT_SENSOR_MM): number =>
  sensorMm / (2 * Math.tan((fovDeg * DEG2RAD) / 2));

/** Horizontal FOV — what Blender's `sensor_fit = HORIZONTAL` uses. */
export const horizontalFovDeg = (focalMm: number): number =>
  fovDegFromFocal(focalMm, SENSOR_WIDTH_MM);

/**
 * Vertical FOV — what three.js `PerspectiveCamera.fov` expects. Mixing the two up frames the
 * product far too tightly, which is exactly the bug this pair of helpers exists to prevent.
 *
 * This is the full-frame vertical angle, so it is only the right number for a viewport shaped like
 * the sensor (3:2). Anything else wants `verticalFovDegForAspect`.
 */
export const verticalFovDeg = (focalMm: number): number =>
  fovDegFromFocal(focalMm, SENSOR_HEIGHT_MM);

/**
 * The vertical FOV that puts a given aspect's horizontal FOV where the renderer puts it.
 *
 * Both renderers fit the horizontal dimension to the sensor width, which is the only choice that
 * survives a change of aspect: the preview canvas is whatever shape the browser window leaves it,
 * and the render is whatever shape was asked for, so anchoring on the shared horizontal angle is
 * what makes the two frames agree. Deriving the vertical angle from a fixed 24 mm instead — which
 * is what a plain `verticalFovDeg` does — is correct at 3:2 and wrong everywhere else; a square
 * render came out visibly wider than the preview that produced it.
 */
export const verticalFovDegForAspect = (focalMm: number, aspect: number): number => {
  const horizontal = fovRadFromFocal(focalMm, SENSOR_WIDTH_MM);
  return (2 * Math.atan(Math.tan(horizontal / 2) / Math.max(aspect, 1e-6)) * 180) / Math.PI;
};

/** Spherical placement around the product: azimuth measured from +Z, elevation from the horizon. */
export function orbitPosition(
  sphere: BoundingSphere,
  azimuthDeg: number,
  elevationDeg: number,
  radiusScale: number,
): Vec3 {
  const r = sphere.radiusMm * radiusScale;
  const az = azimuthDeg * DEG2RAD;
  const el = elevationDeg * DEG2RAD;
  const cosEl = Math.cos(el);
  return [
    sphere.centerMm[0] + r * cosEl * Math.sin(az),
    sphere.centerMm[1] + r * Math.sin(el),
    sphere.centerMm[2] + r * cosEl * Math.cos(az),
  ];
}

export function resolvePreset(preset: CameraPresetDef, sphere: BoundingSphere): ResolvedCamera {
  const target: Vec3 = [
    sphere.centerMm[0] + preset.targetOffsetMm[0],
    sphere.centerMm[1] + preset.targetOffsetMm[1],
    sphere.centerMm[2] + preset.targetOffsetMm[2],
  ];
  return {
    positionMm: orbitPosition(sphere, preset.azimuthDeg, preset.elevationDeg, preset.radiusScale),
    targetMm: target,
    upMm: [0, 1, 0],
    focalMm: preset.focalMm,
    sensorMm: DEFAULT_SENSOR_MM,
  };
}

/** Resolves a design's camera field — preset or custom — into concrete numbers. */
export function resolveCamera(
  camera: Camera,
  sphere: BoundingSphere,
  presets: readonly CameraPresetDef[],
): ResolvedCamera {
  if (camera.kind === 'custom') {
    return {
      positionMm: camera.positionMm,
      targetMm: camera.targetMm,
      upMm: camera.upMm,
      focalMm: camera.focalMm,
      sensorMm: camera.sensorMm,
      ...(camera.fStop === undefined ? {} : { fStop: camera.fStop }),
      ...(camera.focusDistanceMm === undefined ? {} : { focusDistanceMm: camera.focusDistanceMm }),
    };
  }
  const preset = presets.find((p) => p.key === camera.presetKey) ?? presets[0];
  if (!preset) throw new Error(`no camera preset available for "${camera.presetKey}"`);
  return resolvePreset(preset, sphere);
}

/**
 * Distance at which the bounding sphere fills `fill` of the frame's smaller dimension.
 * Defaults to the sensor's short side, so the product fits whichever way the viewport is shaped.
 */
/**
 * How much of the frame's short side the product fills.
 *
 * Shared by the preview and the render service: framing is part of what a user approves, so the two
 * must not each pick their own.
 */
export const DEFAULT_FRAME_FILL = 0.75;

export function distanceForFraming(
  sphere: BoundingSphere,
  focalMm: number,
  sensorMm = SENSOR_HEIGHT_MM,
  fill = DEFAULT_FRAME_FILL,
): number {
  const halfFov = fovRadFromFocal(focalMm, sensorMm) / 2;
  return sphere.radiusMm / (Math.sin(halfFov) * fill);
}

/** Re-frames a camera so the product occupies a consistent share of the frame. */
export function framePreset(
  preset: CameraPresetDef,
  sphere: BoundingSphere,
  fill = DEFAULT_FRAME_FILL,
  orientation?: OrientationFrame,
): ResolvedCamera {
  // Frame against the short sensor dimension so the product fits in either orientation.
  const distance = distanceForFraming(sphere, preset.focalMm, SENSOR_HEIGHT_MM, fill);
  const angles = orientation
    ? preset.key === 'front'
      ? { azimuthDeg: 0, elevationDeg: 0 }
      : preset.key === 'top'
        ? { azimuthDeg: 0, elevationDeg: 90 }
        : preset.key === 'three-quarter'
          ? { azimuthDeg: 35, elevationDeg: 25 }
          : {}
    : {};
  const camera = resolvePreset(
    { ...preset, ...angles, radiusScale: distance / sphere.radiusMm },
    sphere,
  );
  // A straight-down view needs an in-plane Up; parallel look/up vectors leave roll undefined.
  if (orientation && preset.key === 'top') camera.upMm = [0, 0, -1];
  return orientCamera(camera, sphere.centerMm, orientation);
}
