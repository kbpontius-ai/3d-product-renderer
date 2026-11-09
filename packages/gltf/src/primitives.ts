import type { MeshData } from './glb.js';

/**
 * Parametric geometry for fixture packs.
 *
 * Real packs come from tessellated CAD (docs/04-tech-stack.md §3). These stand-ins exist so the
 * whole pipeline — zones, preview, render spec — can run end to end before the OCCT pipeline lands,
 * and so CI has meshes that are small, deterministic and free of licensing questions.
 */

interface Builder {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

const builder = (): Builder => ({ positions: [], normals: [], uvs: [], indices: [] });

function vertex(b: Builder, p: [number, number, number], n: [number, number, number], uv: [number, number]): number {
  b.positions.push(...p);
  b.normals.push(...n);
  b.uvs.push(...uv);
  return b.positions.length / 3 - 1;
}

const quad = (b: Builder, a: number, c: number, d: number, e: number) => {
  b.indices.push(a, c, d, a, d, e);
};

function finish(b: Builder, name: string, material?: number): MeshData {
  return {
    name,
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    indices: new Uint32Array(b.indices),
    ...(material === undefined ? {} : { material }),
  };
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface CapOptions {
  radiusMm: number;
  heightMm: number;
  /** Rounded transition between the top face and the skirt. */
  filletMm?: number;
  /**
   * Wall thickness, which is what makes this a closed solid rather than a shell.
   *
   * Must clear the tolerance a cylindrical zone uses to decide which surface it is on
   * (`zoneUniformValues` in the web app: `max(1, 3 × maxDepthMm)`), or the bore and the skirt are
   * the same surface as far as the shader is concerned. 1.5 mm is also what a real polypropylene
   * closure this size is moulded at.
   */
  wallMm?: number;
  segments?: number;
  /** UV island the flat top is mapped into, matching the pack's uv_rect zones. */
  topUvRect?: UvRect;
  /** UV island the skirt is unwrapped into. */
  skirtUvRect?: UvRect;
  material?: number;
}

/**
 * A closure: flat top, filleted rim, cylindrical skirt, and a moulded cavity underneath.
 *
 * Closed, and it matters. This used to end at the bottom of the outer skirt — no bore, no ceiling,
 * no bottom rim — which is a surface, not a solid. Single-sided materials cull whatever faces away,
 * so looking up at it from below you saw straight through the product to the far side of its own
 * skirt. Real packs come from OCCT, which tessellates a solid and cannot produce that; this fixture
 * stood in for one and did not behave like one.
 */
export function buildCap(options: CapOptions): MeshData {
  const {
    radiusMm: R,
    heightMm: H,
    filletMm = 1.2,
    wallMm = 1.5,
    segments = 128,
    topUvRect = { u0: 0.02, v0: 0.52, u1: 0.48, v1: 0.98 },
    skirtUvRect = { u0: 0.52, v0: 0.02, u1: 0.98, v1: 0.98 },
    material,
  } = options;

  const b = builder();
  const rings = 6; // fillet resolution
  const topRadius = R - filletMm;

  // Flat top as a triangle fan, UV-mapped so the top's bounding square fills `topUvRect`.
  const topUv = (x: number, z: number): [number, number] => [
    lerp(topUvRect.u0, topUvRect.u1, x / (2 * R) + 0.5),
    lerp(topUvRect.v0, topUvRect.v1, z / (2 * R) + 0.5),
  ];
  const centre = vertex(b, [0, H, 0], [0, 1, 0], topUv(0, 0));
  const topRing: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a) * topRadius;
    const z = Math.sin(a) * topRadius;
    topRing.push(vertex(b, [x, H, z], [0, 1, 0], topUv(x, z)));
  }
  for (let i = 0; i < segments; i++) {
    b.indices.push(centre, topRing[(i + 1) % segments]!, topRing[i]!);
  }

  // Fillet: quarter torus from the top plane down to the skirt.
  let previous = topRing;
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const angle = (t * Math.PI) / 2;
    const radius = topRadius + filletMm * Math.sin(angle);
    const y = H - filletMm * (1 - Math.cos(angle));
    const ring: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      const nx = Math.cos(a) * Math.sin(angle);
      const nz = Math.sin(a) * Math.sin(angle);
      const ny = Math.cos(angle);
      ring.push(vertex(b, [x, y, z], [nx, ny, nz], topUv(Math.cos(a) * R, Math.sin(a) * R)));
    }
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      quad(b, previous[i]!, previous[j]!, ring[j]!, ring[i]!);
    }
    previous = ring;
  }

  // Skirt: unwrapped into its own UV island so a cylindrical zone has somewhere to live.
  const skirtTop: number[] = [];
  const skirtBottom: number[] = [];
  const skirtTopY = H - filletMm;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a) * R;
    const z = Math.sin(a) * R;
    const u = lerp(skirtUvRect.u0, skirtUvRect.u1, i / segments);
    skirtTop.push(vertex(b, [x, skirtTopY, z], [Math.cos(a), 0, Math.sin(a)], [u, skirtUvRect.v1]));
    skirtBottom.push(vertex(b, [x, 0, z], [Math.cos(a), 0, Math.sin(a)], [u, skirtUvRect.v0]));
  }
  for (let i = 0; i < segments; i++) {
    quad(b, skirtTop[i]!, skirtTop[i + 1]!, skirtBottom[i + 1]!, skirtBottom[i]!);
  }

  /*
   * The inside: bottom rim, bore, and the ceiling of the cavity.
   *
   * All three are mapped into the UV quadrant the two authored islands leave free, so a `uv_rect`
   * zone addressing the top or the skirt cannot accidentally address the inside of the part as
   * well. Normals point into the cavity, which is where an eye looking up at the closure is.
   */
  const boreRadius = R - wallMm;
  const ceilingY = H - wallMm;
  const insideUv = (u: number, v: number): [number, number] => [lerp(0.02, 0.48, u), lerp(0.02, 0.48, v)];

  const rimOuter: number[] = [];
  const rimInner: number[] = [];
  const boreTop: number[] = [];
  const ceilingRing: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const [cx, cz] = [Math.cos(a), Math.sin(a)];
    const t = i / segments;

    rimOuter.push(vertex(b, [cx * R, 0, cz * R], [0, -1, 0], insideUv(t, 0)));
    rimInner.push(vertex(b, [cx * boreRadius, 0, cz * boreRadius], [0, -1, 0], insideUv(t, 0.2)));
    boreTop.push(vertex(b, [cx * boreRadius, ceilingY, cz * boreRadius], [-cx, 0, -cz], insideUv(t, 0.6)));
    ceilingRing.push(vertex(b, [cx * boreRadius, ceilingY, cz * boreRadius], [0, -1, 0], insideUv(t, 0.8)));
  }
  // A separate bore-bottom ring so the rim and the wall can carry different normals at the same
  // corner: shared vertices there would round the edge of a moulding that is not rounded.
  const boreBottom: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const [cx, cz] = [Math.cos(a), Math.sin(a)];
    boreBottom.push(vertex(b, [cx * boreRadius, 0, cz * boreRadius], [-cx, 0, -cz], insideUv(i / segments, 0.4)));
  }

  const ceilingCentre = vertex(b, [0, ceilingY, 0], [0, -1, 0], insideUv(0.5, 1));

  /*
   * Wound so each face turns its front towards the space it bounds — down for the rim and the
   * ceiling, into the cavity for the bore. Get one of these backwards and the mesh is still closed
   * and still passes an edge count; what gives it away is the enclosed volume, which comes out
   * larger than a solid puck of the same size because the inside is adding volume instead of
   * removing it.
   */
  for (let i = 0; i < segments; i++) {
    quad(b, rimOuter[i]!, rimOuter[i + 1]!, rimInner[i + 1]!, rimInner[i]!);
    quad(b, boreBottom[i]!, boreBottom[i + 1]!, boreTop[i + 1]!, boreTop[i]!);
    b.indices.push(ceilingCentre, ceilingRing[i]!, ceilingRing[i + 1]!);
  }

  return finish(b, 'cap', material);
}

export interface CartonOptions {
  widthMm: number;
  heightMm: number;
  depthMm: number;
  /** UV island per panel, keyed to the pack's flat_panel zones. */
  panelUv: { front: UvRect; back: UvRect; side: UvRect; top: UvRect };
  material?: number;
}

/** A closed rectangular carton with one UV island per panel. */
export function buildCarton(options: CartonOptions): MeshData {
  const { widthMm: W, heightMm: H, depthMm: D, panelUv, material } = options;
  const b = builder();
  const hw = W / 2;
  const hd = D / 2;

  const face = (
    corners: [number, number, number][],
    normal: [number, number, number],
    rect: UvRect,
  ) => {
    const [p0, p1, p2, p3] = corners;
    const a = vertex(b, p0!, normal, [rect.u0, rect.v0]);
    const c = vertex(b, p1!, normal, [rect.u1, rect.v0]);
    const d = vertex(b, p2!, normal, [rect.u1, rect.v1]);
    const e = vertex(b, p3!, normal, [rect.u0, rect.v1]);
    quad(b, a, c, d, e);
  };

  // Front (+z) and back (-z)
  face(
    [
      [-hw, 0, hd],
      [hw, 0, hd],
      [hw, H, hd],
      [-hw, H, hd],
    ],
    [0, 0, 1],
    panelUv.front,
  );
  face(
    [
      [hw, 0, -hd],
      [-hw, 0, -hd],
      [-hw, H, -hd],
      [hw, H, -hd],
    ],
    [0, 0, -1],
    panelUv.back,
  );

  // Right (+x) and left (-x)
  face(
    [
      [hw, 0, hd],
      [hw, 0, -hd],
      [hw, H, -hd],
      [hw, H, hd],
    ],
    [1, 0, 0],
    panelUv.side,
  );
  face(
    [
      [-hw, 0, -hd],
      [-hw, 0, hd],
      [-hw, H, hd],
      [-hw, H, -hd],
    ],
    [-1, 0, 0],
    panelUv.side,
  );

  // Top and bottom
  face(
    [
      [-hw, H, hd],
      [hw, H, hd],
      [hw, H, -hd],
      [-hw, H, -hd],
    ],
    [0, 1, 0],
    panelUv.top,
  );
  face(
    [
      [-hw, 0, -hd],
      [hw, 0, -hd],
      [hw, 0, hd],
      [-hw, 0, hd],
    ],
    [0, -1, 0],
    panelUv.top,
  );

  return finish(b, 'carton', material);
}

export interface BottleOptions {
  /** Semi-axis of the body cross-section along x, at its widest. */
  radiusXMm: number;
  /** Semi-axis along z. Different from `radiusXMm` is what makes the bottle oval. */
  radiusZMm: number;
  heightMm: number;
  /** Fraction of the widest radius the neck narrows to. */
  neckScale?: number;
  segments?: number;
  /** UV island for the wrap-around body. */
  bodyUvRect?: UvRect;
  material?: number;
}

/**
 * An oval bottle: elliptical in section, bellied through the body, shouldered into a neck.
 *
 * The fixture that makes curved relief testable. A cap exercises a flat face and a cylinder, and
 * both of those are *developable* — they unroll without distortion, so a zone laid on either can be
 * spaced by projecting a flat grid and nobody notices. This one cannot be unrolled: the section is
 * an ellipse rather than a circle, and the profile varies with height, so the surface has curvature
 * in two directions at once everywhere on the flank. That is the case an SVG has to emboss correctly
 * on, and until this existed nothing in the repository had it.
 *
 * Closed, for the same reason `buildCap` is: an open shell is not what OCCT produces and not what
 * the preview should be asked to tolerate.
 */
export function buildBottle(options: BottleOptions): MeshData {
  const {
    radiusXMm: RX,
    radiusZMm: RZ,
    heightMm: H,
    neckScale = 0.3,
    segments = 128,
    bodyUvRect = { u0: 0.02, v0: 0.02, u1: 0.98, v1: 0.98 },
    material,
  } = options;

  /**
   * Radius scale at height `t` ∈ [0, 1], as a fraction of the widest section.
   *
   * Four stretches: a base fillet, a bellied body, a cosine shoulder and a straight neck. The belly
   * is the part that matters — a constant section would make an elliptical *cylinder*, which is
   * developable and would quietly let a flat projection look correct.
   */
  const profile = (t: number): number => {
    if (t < 0.05) return lerp(0.82, 1, t / 0.05);                       // base fillet
    if (t < 0.62) {
      const s = (t - 0.05) / 0.57;
      return 1 - 0.06 * (2 * s - 1) ** 2;                                // belly: curved along y too
    }
    if (t < 0.86) {
      const s = (t - 0.62) / 0.24;
      return lerp(1, neckScale, (1 - Math.cos(s * Math.PI)) / 2);        // shoulder
    }
    return neckScale;                                                    // neck
  };

  const rings = Math.max(24, Math.round(segments / 2));
  const b = builder();

  const ringIndices: number[][] = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const y = t * H;
    const scaleAt = profile(t);
    // Slope of the profile, for a normal that follows the surface rather than the section.
    const dt = 1 / (rings * 4);
    const dScale = (profile(Math.min(1, t + dt)) - profile(Math.max(0, t - dt))) / (2 * dt * H);

    const ring: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const [ca, sa] = [Math.cos(a), Math.sin(a)];
      const x = RX * scaleAt * ca;
      const z = RZ * scaleAt * sa;

      /*
       * Normal of a surface of varying elliptical section.
       *
       * The section's own outward direction is the ellipse gradient (x/RX², z/RZ²), not the radial
       * — that difference is the whole reason an oval bottle shades differently from a round one.
       * The profile's slope then tilts it along y.
       */
      const gx = (scaleAt * ca) / RX;
      const gz = (scaleAt * sa) / RZ;
      const gLen = Math.hypot(gx, gz) || 1;
      const outward: [number, number, number] = [gx / gLen, 0, gz / gLen];
      const radialLen = Math.hypot(x, z) || 1;
      const n: [number, number, number] = [outward[0], -dScale * radialLen, outward[2]];
      const nLen = Math.hypot(n[0], n[1], n[2]) || 1;

      ring.push(
        vertex(
          b,
          [x, y, z],
          [n[0] / nLen, n[1] / nLen, n[2] / nLen],
          [lerp(bodyUvRect.u0, bodyUvRect.u1, i / segments), lerp(bodyUvRect.v0, bodyUvRect.v1, t)],
        ),
      );
    }
    ringIndices.push(ring);
  }

  /*
   * Wound upper-ring-first, which is what makes the body face outwards.
   *
   * `buildCap`'s skirt — the same shape, a wall around an axis — winds `skirtTop` before
   * `skirtBottom`; this wound `lower` before `upper` and so came out inside-out. Nothing caught it:
   * the closure test compares edge counts, which is the same either way, and product materials are
   * double-sided (so an open shell degrades to an odd interior rather than a see-through product),
   * which meant the part still drew. What it could not hide is that three.js flips the shading
   * normal on a back face, so the bottle shaded with an inverted normal while the relief patch —
   * a separate, correctly wound mesh — did not. That difference was the rectangle of slightly
   * wrong shading around the artwork.
   */
  for (let r = 0; r < rings; r++) {
    const lower = ringIndices[r]!;
    const upper = ringIndices[r + 1]!;
    for (let i = 0; i < segments; i++) {
      quad(b, upper[i]!, upper[i + 1]!, lower[i + 1]!, lower[i]!);
    }
  }

  // Caps, wound so each faces out of the solid.
  const baseScale = profile(0);
  const topScale = profile(1);
  const baseCentre = vertex(b, [0, 0, 0], [0, -1, 0], [0.5, bodyUvRect.v0]);
  const topCentre = vertex(b, [0, H, 0], [0, 1, 0], [0.5, bodyUvRect.v1]);

  const baseRing: number[] = [];
  const topRing: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const [ca, sa] = [Math.cos(a), Math.sin(a)];
    baseRing.push(vertex(b, [RX * baseScale * ca, 0, RZ * baseScale * sa], [0, -1, 0], [i / segments, bodyUvRect.v0]));
    topRing.push(vertex(b, [RX * topScale * ca, H, RZ * topScale * sa], [0, 1, 0], [i / segments, bodyUvRect.v1]));
  }
  for (let i = 0; i < segments; i++) {
    b.indices.push(baseCentre, baseRing[i]!, baseRing[i + 1]!);
    b.indices.push(topCentre, topRing[i + 1]!, topRing[i]!);
  }

  return finish(b, 'bottle', material);
}
