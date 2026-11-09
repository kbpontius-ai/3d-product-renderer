import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENVIRONMENT_KEY,
  ENVIRONMENTS,
  environmentFor,
  placeLights,
  subjectFromBbox,
  type Vec3,
} from './environments.js';

/**
 * The property that matters: the same environment lights a closure and a carton the same way. A rig
 * that is not scale-invariant renders one product correctly and blows the other to white, and that
 * is the bug this file exists to prevent coming back.
 */

const cap = subjectFromBbox([
  [-19, 0, -19],
  [19, 18, 19],
] as [Vec3, Vec3]);

const carton = subjectFromBbox([
  [-100, 0, -60],
  [100, 240, 60],
] as [Vec3, Vec3]);

describe('environments', () => {
  it('retains the existing studios and adds an explicitly versioned Detail profile', () => {
    expect(ENVIRONMENTS.map((environment) => environment.key)).toEqual([
      'studio-softbox',
      'studio-three-point',
      'studio-sweep',
      'studio-detail-v1',
    ]);
    for (const environment of ENVIRONMENTS) {
      expect(environment.lights.some((light) => light.name === 'key')).toBe(true);
      expect(environment.lights.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('falls back to the default rather than leaving a design unlit', () => {
    expect(environmentFor('no-such-environment').key).toBe(DEFAULT_ENVIRONMENT_KEY);
    expect(environmentFor(undefined).key).toBe(DEFAULT_ENVIRONMENT_KEY);
  });
});

describe('placeLights', () => {
  const softbox = environmentFor('studio-softbox');

  it('sizes and powers the rig from the subject, not from the room', () => {
    const small = placeLights(softbox, cap);
    const large = placeLights(softbox, carton);

    const ratio = carton.radiusMm / cap.radiusMm;
    for (const [index, light] of small.entries()) {
      const big = large[index]!;
      expect(big.sizeMm / light.sizeMm).toBeCloseTo(ratio, 5);
      // Inverse square: four times the distance is sixteen times the power, same exposure.
      expect(big.energyW / light.energyW).toBeCloseTo(ratio * ratio, 3);
    }
  });

  it('keeps every light the same distance from the subject it was authored at', () => {
    for (const light of placeLights(softbox, cap)) {
      const distance = Math.hypot(
        light.positionMm[0] - cap.centreMm[0],
        light.positionMm[1] - cap.centreMm[1],
        light.positionMm[2] - cap.centreMm[2],
      );
      const authored = softbox.lights.find((candidate) => candidate.name === light.name)!;
      expect(distance).toBeCloseTo(cap.radiusMm * authored.distance, 5);
    }
  });

  it('aims everything at the subject', () => {
    for (const light of placeLights(softbox, carton)) {
      expect(light.targetMm).toEqual(carton.centreMm);
    }
  });

  it('rotates the rig about the vertical axis, leaving heights alone', () => {
    const [before] = placeLights(softbox, cap);
    const [after] = placeLights(softbox, cap, 90);

    expect(after!.positionMm[1]).toBeCloseTo(before!.positionMm[1], 6);
    // A quarter turn puts the key where the +z axis was.
    const distance = (light: typeof before) =>
      Math.hypot(light!.positionMm[0] - cap.centreMm[0], light!.positionMm[2] - cap.centreMm[2]);
    expect(distance(after)).toBeCloseTo(distance(before), 6);
    expect(after!.positionMm[0]).not.toBeCloseTo(before!.positionMm[0], 2);
  });

  it('survives a degenerate bounding box rather than dividing by zero', () => {
    const flat = subjectFromBbox([
      [0, 0, 0],
      [0, 0, 0],
    ] as [Vec3, Vec3]);

    for (const light of placeLights(softbox, flat)) {
      expect(Number.isFinite(light.energyW)).toBe(true);
      expect(light.energyW).toBeGreaterThan(0);
    }
  });
});
