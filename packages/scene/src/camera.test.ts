import { describe, expect, it } from 'vitest';
import { boundingSphere, bboxHeightMm, type Bbox } from './bounds.js';
import {
  DEFAULT_SENSOR_MM,
  horizontalFovDeg,
  verticalFovDeg,
  verticalFovDegForAspect,
  distanceForFraming,
  focalFromFovDeg,
  fovDegFromFocal,
  framePreset,
  orbitPosition,
  resolveCamera,
  resolvePreset,
  type CameraPresetDef,
} from './camera.js';

const capBbox: Bbox = [
  [-19, 0, -19],
  [19, 18, 19],
];
const cartonBbox: Bbox = [
  [-40, 0, -20],
  [40, 120, 20],
];

const preset: CameraPresetDef = {
  key: 'three-quarter',
  label: 'Three-quarter',
  azimuthDeg: 35,
  elevationDeg: 25,
  radiusScale: 2.4,
  focalMm: 85,
  targetOffsetMm: [0, 0, 0],
};

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe('boundingSphere', () => {
  it('centres on the bbox and covers its diagonal', () => {
    const s = boundingSphere(capBbox);
    expect(s.centerMm).toEqual([0, 9, 0]);
    expect(s.radiusMm).toBeCloseTo(Math.hypot(38, 18, 38) / 2, 9);
  });

  it('never returns a zero radius', () => {
    expect(
      boundingSphere([
        [0, 0, 0],
        [0, 0, 0],
      ]).radiusMm,
    ).toBeGreaterThan(0);
  });

  it('reports height for sweep placement', () => {
    expect(bboxHeightMm(cartonBbox)).toBe(120);
  });
});

describe('orbitPosition', () => {
  const sphere = boundingSphere(capBbox);

  it('sits at radiusScale times the radius from the centre', () => {
    const p = orbitPosition(sphere, 35, 25, 2.4);
    expect(distance(p, sphere.centerMm)).toBeCloseTo(sphere.radiusMm * 2.4, 6);
  });

  it('places azimuth 0 on +Z and 90 on +X', () => {
    const front = orbitPosition(sphere, 0, 0, 2);
    const side = orbitPosition(sphere, 90, 0, 2);
    expect(front[2]).toBeGreaterThan(0);
    expect(Math.abs(front[0])).toBeLessThan(1e-9);
    expect(side[0]).toBeGreaterThan(0);
    expect(Math.abs(side[2])).toBeLessThan(1e-9);
  });

  it('raises the camera with elevation', () => {
    const low = orbitPosition(sphere, 0, 5, 2);
    const high = orbitPosition(sphere, 0, 60, 2);
    expect(high[1]).toBeGreaterThan(low[1]!);
  });
});

describe('field of view', () => {
  it('matches the renderer formula both ways', () => {
    for (const focal of [24, 50, 85, 120]) {
      expect(focalFromFovDeg(fovDegFromFocal(focal), DEFAULT_SENSOR_MM)).toBeCloseTo(focal, 9);
    }
  });

  it('narrows as focal length grows', () => {
    expect(fovDegFromFocal(120)).toBeLessThan(fovDegFromFocal(35));
  });

  it('keeps horizontal and vertical apart — three.js wants vertical, Blender fits horizontal', () => {
    expect(verticalFovDeg(85)).toBeLessThan(horizontalFovDeg(85));
    expect(horizontalFovDeg(50)).toBeCloseTo(fovDegFromFocal(50, 36), 9);
    expect(verticalFovDeg(50)).toBeCloseTo(fovDegFromFocal(50, 24), 9);
  });

  describe('verticalFovDegForAspect', () => {
    it('agrees with the plain vertical FOV at the sensor aspect, and only there', () => {
      expect(verticalFovDegForAspect(50, 36 / 24)).toBeCloseTo(verticalFovDeg(50), 9);
      expect(verticalFovDegForAspect(50, 1)).not.toBeCloseTo(verticalFovDeg(50), 3);
    });

    it('holds the horizontal angle fixed as the frame changes shape', () => {
      // This is the parity property: whatever shape the viewport or the output is, the width of
      // the world in frame is the same, so the preview and the render show the same thing.
      const horizontal = (focal: number, aspect: number) => {
        const vertical = (verticalFovDegForAspect(focal, aspect) * Math.PI) / 180;
        return ((2 * Math.atan(Math.tan(vertical / 2) * aspect)) * 180) / Math.PI;
      };

      for (const aspect of [0.5, 1, 16 / 9, 3]) {
        expect(horizontal(50, aspect)).toBeCloseTo(horizontalFovDeg(50), 9);
      }
    });

    it('opens up vertically as the frame gets taller', () => {
      expect(verticalFovDegForAspect(50, 1)).toBeGreaterThan(verticalFovDegForAspect(50, 2));
    });
  });
});

describe('resolvePreset / resolveCamera', () => {
  it('aims at the product centre plus the preset offset', () => {
    const sphere = boundingSphere(cartonBbox);
    const c = resolvePreset({ ...preset, targetOffsetMm: [0, 10, 0] }, sphere);
    expect(c.targetMm).toEqual([0, 70, 0]);
  });

  it('resolves a design preset reference', () => {
    const sphere = boundingSphere(capBbox);
    const c = resolveCamera({ kind: 'preset', presetKey: 'three-quarter' }, sphere, [preset]);
    expect(c.focalMm).toBe(85);
  });

  it('falls back to the first preset when the key is unknown', () => {
    const sphere = boundingSphere(capBbox);
    const c = resolveCamera({ kind: 'preset', presetKey: 'missing' }, sphere, [preset]);
    expect(c.positionMm).toEqual(resolvePreset(preset, sphere).positionMm);
  });

  it('passes a custom camera through unchanged', () => {
    const sphere = boundingSphere(capBbox);
    const c = resolveCamera(
      {
        kind: 'custom',
        positionMm: [1, 2, 3],
        targetMm: [0, 0, 0],
        upMm: [0, 1, 0],
        focalMm: 50,
        sensorMm: 36,
        fStop: 2.8,
      },
      sphere,
      [preset],
    );
    expect(c.positionMm).toEqual([1, 2, 3]);
    expect(c.fStop).toBe(2.8);
  });

  it('throws only when there is nothing to fall back to', () => {
    expect(() => resolveCamera({ kind: 'preset', presetKey: 'x' }, boundingSphere(capBbox), [])).toThrow();
  });
});

describe('framing is product-agnostic', () => {
  it('frames a 38 mm cap and a 120 mm carton to the same share of frame', () => {
    const cap = boundingSphere(capBbox);
    const carton = boundingSphere(cartonBbox);

    const capCam = framePreset(preset, cap);
    const cartonCam = framePreset(preset, carton);

    const capRatio = cap.radiusMm / distance(capCam.positionMm, capCam.targetMm);
    const cartonRatio = carton.radiusMm / distance(cartonCam.positionMm, cartonCam.targetMm);
    expect(capRatio).toBeCloseTo(cartonRatio, 9);
  });

  it('moves the camera further away for a longer lens', () => {
    const sphere = boundingSphere(capBbox);
    expect(distanceForFraming(sphere, 120)).toBeGreaterThan(distanceForFraming(sphere, 50));
  });

  it('fills more of the frame as the fill factor rises', () => {
    const sphere = boundingSphere(capBbox);
    expect(distanceForFraming(sphere, 85, DEFAULT_SENSOR_MM, 0.95)).toBeLessThan(
      distanceForFraming(sphere, 85, DEFAULT_SENSOR_MM, 0.6),
    );
  });

  it('frames against the short sensor dimension by default, so nothing is cropped', () => {
    const sphere = boundingSphere(capBbox);
    const framed = framePreset(preset, sphere, 0.8);
    const d = distance(framed.positionMm, framed.targetMm);
    const halfHeightAtDistance = d * Math.tan((verticalFovDeg(preset.focalMm) * Math.PI) / 360);
    expect(halfHeightAtDistance).toBeGreaterThan(sphere.radiusMm);
  });
});
