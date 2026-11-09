/**
 * Curated studio environments (F-SCENE-01).
 *
 * One definition, two renderers. The preview and Cycles previously lit the product differently —
 * three.js' procedural room on one side, a hand-written rig on the other — which meant every
 * comparison between them was measuring the lighting as much as the geometry. This is the rig, as
 * data: directions, sizes and irradiance targets, with no renderer's vocabulary in it.
 *
 * Everything is relative to the subject's bounding sphere, so the same environment lights a 38 mm
 * closure and a 300 mm carton the same way. A studio built for one and used for the other is how
 * renders come out blown to white.
 */

import type { OrientationFrame } from '@pr/design-schema';
import { orientationDirection } from './orientation.js';

export type Vec3 = readonly [number, number, number];

export interface StudioLight {
  name: string;
  /** Direction from the subject towards the light; normalised on use. */
  direction: Vec3;
  /** Distance from the subject, in bounding-sphere radii. */
  distance: number;
  /** Emitter size, in bounding-sphere radii. Larger is softer. */
  size: number;
  /**
   * Target irradiance at the subject, in watts per square metre.
   *
   * The scale-invariant part: power is derived from this and the distance, so moving a light does
   * not silently change the exposure.
   */
  irradiance: number;
  colorHex?: string;
}

export type WorldBackground =
  | { kind: 'gradient'; topHex: string; bottomHex: string }
  | { kind: 'solid'; colorHex: string };

export interface StudioEnvironment {
  key: string;
  name: string;
  description: string;
  lights: StudioLight[];
  /** What the camera sees behind the product when the design asks for the studio. */
  world: WorldBackground;
  /**
   * How strongly the backdrop is lit, and therefore how bright it photographs.
   *
   * Shared rather than hardcoded on each side: the renderer applied 0.6 to its world shader while
   * the preview painted the raw colour, so the same design previewed against a backdrop two and a
   * half times brighter than the one it rendered against.
   */
  backdropStrength: number;
  /** Uniform light from everywhere, as a fraction of the key's irradiance. Fills the shadows. */
  ambient: number;
}

export const DETAIL_STUDIO: StudioEnvironment = {
  key: 'studio-detail-v1',
  name: 'Detail',
  description: 'Bright frontal illumination with oblique highlights for artwork inspection.',
  lights: [
    { name: 'key', direction: [-0.85, 0.3, 0.5], distance: 3.2, size: 1.2, irradiance: 2.6 },
    { name: 'front', direction: [0.15, 0.2, 1], distance: 3, size: 4, irradiance: 1 },
    { name: 'fill', direction: [0.7, -0.2, 0.65], distance: 4, size: 3, irradiance: 0.3 },
    { name: 'rim', direction: [0.4, 0.6, -0.7], distance: 4, size: 1.4, irradiance: 0.8 },
  ],
  world: { kind: 'gradient', topHex: '#f8f9fa', bottomHex: '#e1e6eb' },
  backdropStrength: 0.6,
  ambient: 0.04,
};

export const ENVIRONMENTS: readonly StudioEnvironment[] = [
  {
    key: 'studio-softbox',
    name: 'Softbox',
    description: 'One large source, high and to the left. Clean, product-catalogue lighting.',
    lights: [
      { name: 'key', direction: [-0.45, 0.8, 0.4], distance: 3.2, size: 4.5, irradiance: 1.8 },
      { name: 'fill', direction: [0.7, 0.25, 0.5], distance: 5, size: 5, irradiance: 0.45 },
      { name: 'rim', direction: [0.15, 0.5, -0.9], distance: 4.5, size: 2, irradiance: 0.7 },
    ],
    world: { kind: 'gradient', topHex: '#3a3f4a', bottomHex: '#14161b' },
    backdropStrength: 0.6,
    ambient: 0.08,
  },
  {
    key: 'studio-three-point',
    name: 'Three point',
    description: 'Key, fill and rim at even spacing. More contrast; shows relief and bevels.',
    lights: [
      { name: 'key', direction: [0.55, 0.75, 0.45], distance: 4, size: 3, irradiance: 1.6 },
      { name: 'fill', direction: [-0.7, 0.35, 0.4], distance: 5, size: 4, irradiance: 0.55 },
      { name: 'rim', direction: [0.1, 0.55, -0.85], distance: 4.5, size: 2.5, irradiance: 0.9 },
    ],
    world: { kind: 'gradient', topHex: '#2f333c', bottomHex: '#0f1115' },
    backdropStrength: 0.6,
    ambient: 0.06,
  },
  {
    key: 'studio-sweep',
    name: 'Gradient sweep',
    description: 'A bright seamless backdrop with soft frontal light. Flattering, low contrast.',
    lights: [
      { name: 'key', direction: [0, 0.9, 0.6], distance: 3.5, size: 6, irradiance: 1.5 },
      { name: 'left', direction: [-0.85, 0.3, 0.3], distance: 4.5, size: 4, irradiance: 0.6 },
      { name: 'right', direction: [0.85, 0.3, 0.3], distance: 4.5, size: 4, irradiance: 0.6 },
    ],
    world: { kind: 'gradient', topHex: '#e9ecf2', bottomHex: '#9aa3b2' },
    backdropStrength: 0.6,
    ambient: 0.18,
  },
  DETAIL_STUDIO,
];

export const DEFAULT_ENVIRONMENT_KEY = 'studio-softbox';

export function environmentFor(key: string | undefined): StudioEnvironment {
  return (
    ENVIRONMENTS.find((environment) => environment.key === key) ??
    ENVIRONMENTS.find((environment) => environment.key === DEFAULT_ENVIRONMENT_KEY)!
  );
}

/** A light placed around a real subject: millimetres and watts, ready for either renderer. */
export interface PlacedLight {
  name: string;
  positionMm: Vec3;
  targetMm: Vec3;
  sizeMm: number;
  energyW: number;
  colorHex: string;
  /**
   * The authored irradiance at the subject.
   *
   * Carried through because a real-time renderer has no use for watts: three.js lights are relative
   * and unitless, and irradiance is the quantity both sides actually agree on.
   */
  irradiance: number;
}

export interface Subject {
  centreMm: Vec3;
  radiusMm: number;
}

/**
 * Places an environment's lights around a subject.
 *
 * Power falls out of the inverse-square law from the irradiance target, which is what makes the rig
 * scale-invariant: double the product's size and every light moves twice as far and gets four times
 * the power, leaving the exposure where it was.
 */
export function placeLights(
  environment: StudioEnvironment,
  subject: Subject,
  rotationDeg = 0,
  orientation?: OrientationFrame,
): PlacedLight[] {
  const radius = subject.radiusMm || 1;

  return environment.lights.map((light) => {
    const local = rotateY(normalize(light.direction), rotationDeg);
    const direction = orientation ? orientationDirection([...local], orientation) : local;
    const distanceMm = radius * light.distance;
    const distanceM = distanceMm / 1000;

    return {
      name: light.name,
      positionMm: [
        subject.centreMm[0] + direction[0] * distanceMm,
        subject.centreMm[1] + direction[1] * distanceMm,
        subject.centreMm[2] + direction[2] * distanceMm,
      ] as Vec3,
      targetMm: subject.centreMm,
      sizeMm: radius * light.size,
      energyW: light.irradiance * 4 * Math.PI * distanceM * distanceM,
      colorHex: light.colorHex ?? '#ffffff',
      irradiance: light.irradiance,
    };
  });
}

/** The subject a rig is built around, from a pack's bounding box. */
export function subjectFromBbox(bbox: readonly [Vec3, Vec3]): Subject {
  const [min, max] = bbox;
  return {
    centreMm: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] as Vec3,
    radiusMm: Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1,
  };
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Environment rotation is about the vertical axis, which is the only one anyone ever wants. */
function rotateY(v: Vec3, degrees: number): Vec3 {
  if (!degrees) return v;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [v[0] * cos + v[2] * sin, v[1], -v[0] * sin + v[2] * cos];
}
