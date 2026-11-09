import type { Vec3 } from '@pr/design-schema';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-12) throw new Error('cannot normalize a zero-length vector');
  return scale(a, 1 / l);
}

/** Gram-Schmidt: the component of `v` perpendicular to `axis`, normalized. */
export function orthogonalize(v: Vec3, axis: Vec3): Vec3 {
  const n = normalize(axis);
  return normalize(sub(v, scale(n, dot(v, n))));
}

/** Any unit vector perpendicular to `a`, chosen deterministically. */
export function anyPerpendicular(a: Vec3): Vec3 {
  const n = normalize(a);
  const candidate: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return orthogonalize(candidate, n);
}

/** Wraps an angle (radians) into (-PI, PI]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  const x = ((a + Math.PI) % twoPi + twoPi) % twoPi;
  return x - Math.PI;
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
