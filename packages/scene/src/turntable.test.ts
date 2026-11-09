import { describe, expect, it } from 'vitest';
import { boundingSphere, type Bbox } from './bounds.js';
import {
  DEFAULT_ORBIT,
  turntableCamera,
  turntableFrameCount,
  turntablePath,
} from './turntable.js';

const capBbox: Bbox = [
  [-19, 0, -19],
  [19, 18, 19],
];
const cartonBbox: Bbox = [
  [-40, 0, -20],
  [40, 120, 20],
];

const options = { fps: 30, durationSec: 8 };

describe('turntable', () => {
  const sphere = boundingSphere(capBbox);

  it('produces fps x duration frames', () => {
    expect(turntableFrameCount(options)).toBe(240);
    expect(turntablePath(sphere, DEFAULT_ORBIT, options)).toHaveLength(240);
  });

  it('keeps a constant distance and elevation throughout the orbit', () => {
    const path = turntablePath(sphere, DEFAULT_ORBIT, options);
    const radii = path.map((c) =>
      Math.hypot(
        c.positionMm[0] - sphere.centerMm[0],
        c.positionMm[1] - sphere.centerMm[1],
        c.positionMm[2] - sphere.centerMm[2],
      ),
    );
    const heights = path.map((c) => c.positionMm[1]);
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1e-6);
  });

  it('loops seamlessly: the last frame stops just short of the first', () => {
    const path = turntablePath(sphere, DEFAULT_ORBIT, options);
    const first = path[0]!;
    const last = path[path.length - 1]!;
    const step = 360 / path.length;
    const angleOf = (p: readonly number[]) =>
      (Math.atan2(p[0]! - sphere.centerMm[0], p[2]! - sphere.centerMm[2]) * 180) / Math.PI;
    const delta = ((angleOf(last.positionMm) - angleOf(first.positionMm) + 360) % 360);
    expect(delta).toBeCloseTo(360 - step, 6);
  });

  it('ends on a full revolution when not looping', () => {
    const path = turntablePath(sphere, { ...DEFAULT_ORBIT, loop: false }, { fps: 4, durationSec: 1 });
    expect(path[0]!.positionMm[0]).toBeCloseTo(path[path.length - 1]!.positionMm[0], 6);
    expect(path[0]!.positionMm[2]).toBeCloseTo(path[path.length - 1]!.positionMm[2], 6);
  });

  it('always looks at the product centre', () => {
    for (const c of turntablePath(sphere, DEFAULT_ORBIT, { fps: 2, durationSec: 2 })) {
      expect(c.targetMm).toEqual(sphere.centerMm);
    }
  });

  it('uses the same path for a cap and a carton, scaled to each product', () => {
    const carton = boundingSphere(cartonBbox);
    const capCam = turntableCamera(sphere, DEFAULT_ORBIT, options, 17);
    const cartonCam = turntableCamera(carton, DEFAULT_ORBIT, options, 17);

    const relative = (c: { positionMm: readonly number[] }, s: typeof sphere) => [
      (c.positionMm[0]! - s.centerMm[0]) / s.radiusMm,
      (c.positionMm[1]! - s.centerMm[1]) / s.radiusMm,
      (c.positionMm[2]! - s.centerMm[2]) / s.radiusMm,
    ];
    const a = relative(capCam, sphere);
    const b = relative(cartonCam, carton);
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 9);
  });

  it('is deterministic', () => {
    expect(turntableCamera(sphere, DEFAULT_ORBIT, options, 42)).toEqual(
      turntableCamera(sphere, DEFAULT_ORBIT, options, 42),
    );
  });
});
