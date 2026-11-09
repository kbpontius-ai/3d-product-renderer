import { describe, expect, it } from 'vitest';
import { OrientationFrame, type Vec3 } from '@pr/design-schema';
import {
  frameFromDirections,
  flipFront,
  turnUp,
  IMPORTED_FRAME,
  orientationDirection,
  orientCamera,
  effectiveOrientation,
} from './orientation.js';
import { framePreset } from './camera.js';
import { boundingSphere } from './bounds.js';
import { environmentFor, placeLights, subjectFromBbox } from './environments.js';
import { turntableCamera, DEFAULT_ORBIT } from './turntable.js';

const bbox: [Vec3, Vec3] = [
  [-19, 0, -19],
  [19, 18, 19],
];
const sphere = boundingSphere(bbox);
const facingY = frameFromDirections([0, 1, 0], [0, 0, -1]);
const preset = {
  key: 'front',
  label: 'Front',
  azimuthDeg: 0,
  elevationDeg: 0,
  radiusScale: 2.4,
  focalMm: 85,
  targetOffsetMm: [0, 0, 0] as Vec3,
};
const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((n, i) => expect(n).toBeCloseTo(b[i]!, 8));

describe('product orientation', () => {
  it('normalizes valid directions without guessing an upright for parallel input', () => {
    expect(frameFromDirections([0, 0, 5], [0, 2, 3])).toEqual(IMPORTED_FRAME);
    for (const [front, up] of [
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 1, 0],
        [0, 2, 0],
      ],
      [
        [NaN, 0, 0],
        [0, 1, 0],
      ],
    ] as [Vec3, Vec3][])
      expect(() => frameFromDirections(front, up)).toThrow();
  });
  it('validates unit length and orthogonality at the shared boundary', () => {
    expect(OrientationFrame.safeParse({ ...IMPORTED_FRAME, upSource: [0, 2, 0] }).success).toBe(
      false,
    );
    expect(OrientationFrame.safeParse({ ...IMPORTED_FRAME, upSource: [0, 0, 1] }).success).toBe(
      false,
    );
  });
  it('keeps Front normal and Up tangent in a right-handed basis', () => {
    close(orientationDirection([0, 0, 1], facingY), [0, 1, 0]);
    close(orientationDirection([0, 1, 0], facingY), [0, 0, -1]);
    close(orientationDirection([1, 0, 0], facingY), [1, 0, 0]);
  });
  it('supports symmetric flip and quarter-turn operations', () => {
    close(flipFront(flipFront(facingY)).frontSource, facingY.frontSource);
    close(turnUp(turnUp(turnUp(turnUp(facingY)))).upSource, facingY.upSource);
    expect(turnUp(facingY).frontSource).toEqual(facingY.frontSource);
  });
  it('uses the override, confirmed variant default, then legacy semantics', () => {
    expect(effectiveOrientation({ ...facingY, confirmed: false })).toBeUndefined();
    expect(effectiveOrientation(undefined)).toBeUndefined();
    expect(effectiveOrientation({ ...facingY, confirmed: true }, IMPORTED_FRAME)).toBe(
      IMPORTED_FRAME,
    );
  });
  it('preserves historical camera resolution without a frame', () => {
    const camera = framePreset(preset, sphere);
    expect(orientCamera(camera, sphere.centerMm)).toBe(camera);
    close(framePreset(preset, sphere, undefined, IMPORTED_FRAME).positionMm, camera.positionMm);
  });
  it('makes named views semantic only after explicit orientation confirmation', () => {
    const old = { ...preset, elevationDeg: 5 };
    const legacy = framePreset(old, sphere);
    const front = framePreset(old, sphere, undefined, facingY);
    close(
      front.positionMm.map((n, i) => n - sphere.centerMm[i]!),
      facingY.frontSource.map(
        (n) => n * Math.hypot(...legacy.positionMm.map((v, i) => v - sphere.centerMm[i]!)),
      ),
    );
    const top = framePreset(
      { ...preset, key: 'top', elevationDeg: 88 },
      sphere,
      undefined,
      facingY,
    );
    close(
      top.upMm,
      facingY.frontSource.map((n) => -n),
    );
    close(
      top.positionMm.map((n, i) => n - sphere.centerMm[i]!),
      facingY.upSource.map(
        (n) => n * Math.hypot(...top.positionMm.map((v, i) => v - sphere.centerMm[i]!)),
      ),
    );
    expect(legacy.positionMm[1]).toBeGreaterThan(sphere.centerMm[1]);
  });

  it('frames equivalent +Z and +Y products with equal distance and lens', () => {
    const z = framePreset(preset, sphere, undefined, IMPORTED_FRAME);
    const y = framePreset(preset, sphere, undefined, facingY);
    close(
      y.positionMm.map((n, i) => n - sphere.centerMm[i]!),
      orientationDirection(z.positionMm.map((n, i) => n - sphere.centerMm[i]!) as Vec3, facingY),
    );
    close(y.upMm, facingY.upSource);
    expect(y.focalMm).toBe(z.focalMm);
  });
  it('rotates light positions with the same basis while retaining size and power', () => {
    const subject = subjectFromBbox(bbox);
    const rig = environmentFor('studio-softbox');
    const baseline = placeLights(rig, subject, 30);
    const oriented = placeLights(rig, subject, 30, facingY);
    oriented.forEach((light, i) => {
      const old = baseline[i]!;
      close(
        light.positionMm.map((n, j) => n - subject.centreMm[j]!),
        orientationDirection(
          old.positionMm.map((n, j) => n - subject.centreMm[j]!) as Vec3,
          facingY,
        ),
      );
      expect(light.energyW).toBe(old.energyW);
      expect(light.sizeMm).toBe(old.sizeMm);
      expect(light.targetMm).toEqual(old.targetMm);
    });
  });
  it('rotates the shared future turntable path without changing legacy paths', () => {
    const old = turntableCamera(sphere, DEFAULT_ORBIT, { fps: 24, durationSec: 8 }, 17);
    const next = turntableCamera(
      sphere,
      DEFAULT_ORBIT,
      { fps: 24, durationSec: 8, orientation: facingY },
      17,
    );
    close(next.positionMm, orientCamera(old, sphere.centerMm, facingY).positionMm);
  });
});
