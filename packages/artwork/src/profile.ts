/**
 * The surface profile of an embossed / debossed feature.
 *
 * This is the single definition of what "emboss" means in this system. The GLSL preview shader
 * (docs/16-preview-engine.md) and the render worker's height-map baking step
 * (docs/17-render-service.md) both implement it; CI sweeps the two against this file.
 *
 * Everything is expressed as a function of the signed distance `d` from the artwork edge, in
 * millimetres, positive inside the artwork. Because |grad(SDF)| = 1, the surface gradient is
 * simply dh/dd times the SDF gradient — no neighbour sampling required.
 */

export type ReliefKind = 'emboss' | 'deboss';

export interface FinishParams {
  /** Full relief height in millimetres. */
  depthMm: number;
  /** Draft angle of the side wall measured from the base surface. 90 = vertical wall. */
  bevelDeg: number;
  /** Radius of the circular fillet where the wall meets the plateau. */
  edgeRadiusMm: number;
  kind: ReliefKind;
}

/** Slope is unbounded at a vertical wall; clamp so normals stay finite. */
export const MAX_SLOPE = 1e4;
const DEG2RAD = Math.PI / 180;
const EPS = 1e-9;

export interface ProfileGeometry {
  depthMm: number;
  /** Horizontal run of the draft wall: depth / tan(bevel). Zero for a vertical wall. */
  wallMm: number;
  /** Ramp slope (dh/dd) along the draft wall. Infinity for a vertical wall. */
  slope: number;
  /** Fillet radius after clamping to what the geometry can accommodate. */
  radiusMm: number;
  /** Distance at which the ramp meets the fillet. */
  tangentMm: number;
  /** Distance at which the fillet meets the plateau (full depth from here on). */
  plateauMm: number;
  vertical: boolean;
}

/** Horizontal run of the draft wall for a given depth and bevel angle. */
export function wallWidthMm(depthMm: number, bevelDeg: number): number {
  if (bevelDeg >= 90 - 1e-6) return 0;
  return depthMm / Math.tan(bevelDeg * DEG2RAD);
}

/**
 * Pre-computes the piecewise geometry: ramp -> circular fillet -> plateau.
 * The fillet is a true circle tangent to both the ramp and the plateau, which is what a milled or
 * moulded edge actually looks like, and keeps dh/dd continuous through the transition.
 */
export function profileGeometry(p: FinishParams): ProfileGeometry {
  const depthMm = Math.max(0, p.depthMm);
  const wallMm = wallWidthMm(depthMm, p.bevelDeg);
  const vertical = wallMm <= EPS;
  const slope = vertical ? Infinity : depthMm / wallMm;

  // A fillet cannot be larger than half the relief height, nor half the wall run.
  const radiusMm = Math.max(
    0,
    Math.min(p.edgeRadiusMm, depthMm / 2, vertical ? Number.POSITIVE_INFINITY : wallMm / 2),
  );

  if (radiusMm <= EPS) {
    return { depthMm, wallMm, slope, radiusMm: 0, tangentMm: wallMm, plateauMm: wallMm, vertical };
  }

  if (vertical) {
    // Corner at (0, depth): the circle centre sits one radius in and one radius down.
    return { depthMm, wallMm, slope, radiusMm, tangentMm: 0, plateauMm: radiusMm, vertical };
  }

  const s = Math.hypot(slope, 1);
  const plateauMm = (depthMm - radiusMm + radiusMm * s) / slope; // circle centre, tangent to plateau
  const tangentMm = plateauMm - (radiusMm * slope) / s; // foot of the perpendicular onto the ramp
  return { depthMm, wallMm, slope, radiusMm, tangentMm, plateauMm, vertical };
}

/**
 * Height of the surface at signed distance `dMm` from the artwork edge.
 * Returns 0 outside the artwork; positive for emboss, negative for deboss.
 */
export function heightMm(dMm: number, p: FinishParams): number {
  if (!(dMm > 0)) return 0;
  const g = profileGeometry(p);
  const h = heightFromGeometry(dMm, g);
  return p.kind === 'deboss' ? -h : h;
}

/** dh/dd at signed distance `dMm`. Sign follows `kind`, matching {@link heightMm}. */
export function dHeightdD(dMm: number, p: FinishParams): number {
  if (!(dMm > 0)) return 0;
  const g = profileGeometry(p);
  const slope = slopeFromGeometry(dMm, g);
  return p.kind === 'deboss' ? -slope : slope;
}

function heightFromGeometry(dMm: number, g: ProfileGeometry): number {
  if (dMm >= g.plateauMm) return g.depthMm;
  if (g.radiusMm > 0 && dMm > g.tangentMm) {
    const dx = dMm - g.plateauMm; // negative inside the fillet
    const under = Math.max(0, g.radiusMm * g.radiusMm - dx * dx);
    return g.depthMm - g.radiusMm + Math.sqrt(under);
  }
  // A vertical wall has plateauMm = 0 (or = radius with a fillet), so it is already handled above:
  // the height simply jumps at d = 0, which the shader resolves with edge coverage.
  return g.slope * dMm;
}

function slopeFromGeometry(dMm: number, g: ProfileGeometry): number {
  if (dMm >= g.plateauMm) return 0;
  if (g.radiusMm > 0 && dMm > g.tangentMm) {
    const dx = dMm - g.plateauMm;
    const under = g.radiusMm * g.radiusMm - dx * dx;
    if (under <= EPS) return MAX_SLOPE;
    return Math.min(MAX_SLOPE, -dx / Math.sqrt(under));
  }
  return g.slope;
}

/**
 * Peak height reached by a feature of the given width — the reason thin strokes look shallow.
 * A stroke narrower than 2 x the wall run never reaches full depth, in preview and in the render
 * alike, which is exactly what the `thin_strokes` warning is telling the user.
 */
export function peakHeightMm(featureWidthMm: number, p: FinishParams): number {
  return heightMm(featureWidthMm / 2, p);
}

/** Smallest feature width that reaches full depth for these finish parameters. */
export function fullDepthWidthMm(p: FinishParams): number {
  return 2 * profileGeometry(p).plateauMm;
}
