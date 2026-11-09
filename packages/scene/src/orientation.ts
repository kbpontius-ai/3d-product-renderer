import { OrientationFrame, type PresentationOrientation, type Vec3 } from '@pr/design-schema';
import type { ResolvedCamera } from './camera.js';

export const IMPORTED_FRAME: OrientationFrame = {
  version: 1,
  frontSource: [0, 0, 1],
  upSource: [0, 1, 0],
};
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, n, i) => sum + n * b[i]!, 0);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  if (!Number.isFinite(length) || length < 1e-6)
    throw new Error('Choose an Up direction perpendicular to Front.');
  return v.map((n) => n / length) as Vec3;
};

export function frameFromDirections(front: Vec3, up: Vec3): OrientationFrame {
  const f = unit(front);
  const projection = dot(f, up);
  return OrientationFrame.parse({
    version: 1,
    frontSource: f,
    upSource: unit(up.map((n, i) => n - f[i]! * projection) as Vec3),
  });
}

export function effectiveOrientation(
  variant: PresentationOrientation | undefined,
  override?: OrientationFrame,
): OrientationFrame | undefined {
  return override ?? (variant?.confirmed ? variant : undefined);
}

export function orientationDirection(direction: Vec3, frame: OrientationFrame): Vec3 {
  const right = cross(frame.upSource, frame.frontSource);
  return direction.map(
    (_, i) =>
      right[i]! * direction[0] +
      frame.upSource[i]! * direction[1] +
      frame.frontSource[i]! * direction[2],
  ) as Vec3;
}

export function orientCamera(
  camera: ResolvedCamera,
  center: Vec3,
  frame?: OrientationFrame,
): ResolvedCamera {
  if (!frame) return camera;
  const point = (v: Vec3): Vec3 => {
    const rotated = orientationDirection(v.map((n, i) => n - center[i]!) as Vec3, frame);
    return rotated.map((n, i) => n + center[i]!) as Vec3;
  };
  return {
    ...camera,
    positionMm: point(camera.positionMm),
    targetMm: point(camera.targetMm),
    upMm: orientationDirection(camera.upMm, frame),
  };
}

export function flipFront(frame: OrientationFrame): OrientationFrame {
  return { ...frame, frontSource: frame.frontSource.map((n) => -n) as Vec3 };
}

export function turnUp(frame: OrientationFrame): OrientationFrame {
  return { ...frame, upSource: cross(frame.upSource, frame.frontSource) };
}
