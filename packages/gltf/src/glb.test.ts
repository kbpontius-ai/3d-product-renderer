import { describe, expect, it } from 'vitest';
import { buildBottle, buildCap, buildCarton, encodeGlb, GLB_CONSTANTS } from './index.js';

function parseGlb(glb: Buffer) {
  expect(glb.readUInt32LE(0)).toBe(GLB_CONSTANTS.GLB_MAGIC);
  expect(glb.readUInt32LE(4)).toBe(2);
  expect(glb.readUInt32LE(8)).toBe(glb.length);

  const jsonLength = glb.readUInt32LE(12);
  expect(glb.readUInt32LE(16)).toBe(GLB_CONSTANTS.CHUNK_JSON);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));

  const binOffset = 20 + jsonLength;
  const binLength = glb.readUInt32LE(binOffset);
  expect(glb.readUInt32LE(binOffset + 4)).toBe(GLB_CONSTANTS.CHUNK_BIN);
  return { json, binLength, bin: glb.subarray(binOffset + 8) };
}

const cap = buildCap({ radiusMm: 19, heightMm: 18, segments: 32 });
const carton = buildCarton({
  widthMm: 80,
  heightMm: 120,
  depthMm: 40,
  panelUv: {
    front: { u0: 0.02, v0: 0.02, u1: 0.4, v1: 0.62 },
    back: { u0: 0.02, v0: 0.64, u1: 0.4, v1: 0.98 },
    side: { u0: 0.42, v0: 0.02, u1: 0.61, v1: 0.62 },
    top: { u0: 0.63, v0: 0.02, u1: 0.98, v1: 0.3 },
  },
});

describe('encodeGlb', () => {
  const glb = encodeGlb([cap], [{ name: 'default' }]);
  const { json, binLength, bin } = parseGlb(glb);

  it('writes a valid GLB container', () => {
    expect(json.asset.version).toBe('2.0');
    expect(bin.length).toBeGreaterThanOrEqual(binLength);
  });

  it('describes one node, one mesh and one primitive', () => {
    expect(json.nodes).toHaveLength(1);
    expect(json.meshes[0].primitives).toHaveLength(1);
    expect(json.meshes[0].primitives[0].mode).toBe(4);
  });

  it('declares position, normal and uv attributes plus indices', () => {
    const attributes = json.meshes[0].primitives[0].attributes;
    expect(attributes).toHaveProperty('POSITION');
    expect(attributes).toHaveProperty('NORMAL');
    expect(attributes).toHaveProperty('TEXCOORD_0');
    expect(json.meshes[0].primitives[0].indices).toBeGreaterThanOrEqual(0);
  });

  it('records position bounds, which viewers rely on for framing', () => {
    const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    expect(accessor.min[1]).toBeCloseTo(0, 5); // cap sits on y = 0
    expect(accessor.max[1]).toBeCloseTo(18, 5);
    expect(accessor.max[0]).toBeLessThanOrEqual(19.0001);
  });

  it('pads chunks to four-byte boundaries', () => {
    expect(glb.length % 4).toBe(0);
    expect(glb.readUInt32LE(12) % 4).toBe(0);
  });

  it('carries the materials it was given', () => {
    expect(json.materials[0].name).toBe('default');
  });
});

describe('buildCap', () => {
  it('has matching attribute counts and an index that stays in range', () => {
    expect(cap.positions.length).toBe(cap.normals.length);
    expect(cap.positions.length / 3).toBe(cap.uvs!.length / 2);
    expect(cap.indices.length % 3).toBe(0);
    expect(Math.max(...cap.indices)).toBeLessThan(cap.positions.length / 3);
  });

  /**
   * Actually closed, which the test above used to be *named* for and never checked.
   *
   * A closure with no bore, no ceiling and no bottom rim passes every attribute-count assertion
   * ever written and is still a surface rather than a solid — and a single-sided material culls
   * whatever faces away, so looking up at it you saw straight through the product. Counting edges
   * is the check that would have caught it.
   *
   * Edges are compared by position rather than by vertex index: the seams of a cylinder duplicate
   * vertices on purpose, to carry different normals and UVs at the same point in space, and an
   * index-based count calls every one of those a hole.
   */
  it('is closed: every edge is shared by exactly two triangles', () => {
    const key = (index: number): string => {
      const round = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Number(v.toFixed(4)));
      return `${round(cap.positions[index * 3]!)},${round(cap.positions[index * 3 + 1]!)},${round(
        cap.positions[index * 3 + 2]!,
      )}`;
    };

    const uses = new Map<string, number>();
    for (let t = 0; t < cap.indices.length; t += 3) {
      const corners = [key(cap.indices[t]!), key(cap.indices[t + 1]!), key(cap.indices[t + 2]!)];
      for (let c = 0; c < 3; c++) {
        const from = corners[c]!;
        const to = corners[(c + 1) % 3]!;
        if (from === to) continue; // a degenerate edge on the fan's centre pole
        const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
        uses.set(edge, (uses.get(edge) ?? 0) + 1);
      }
    }

    const open = [...uses.entries()].filter(([, count]) => count !== 2);
    expect(open.map(([edge, count]) => `${edge} used ${count}×`)).toEqual([]);
  });

  it('encloses a volume consistent with a moulded wall, not a solid puck', () => {
    // Signed volume by the divergence theorem. A closed mesh gives a positive, finite answer; the
    // old open shell gave whatever the missing faces happened to leave behind.
    let volume = 0;
    for (let t = 0; t < cap.indices.length; t += 3) {
      const p = (k: number) => {
        const i = cap.indices[t + k]!;
        return [cap.positions[i * 3]!, cap.positions[i * 3 + 1]!, cap.positions[i * 3 + 2]!] as const;
      };
      const [a, b, c] = [p(0), p(1), p(2)];
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }

    // A 19 mm × 18 mm puck would be about 20 400 mm³; a 1.5 mm wall is a small fraction of that.
    const solid = Math.PI * 19 * 19 * 18;
    expect(Math.abs(volume)).toBeGreaterThan(solid * 0.1);
    expect(Math.abs(volume)).toBeLessThan(solid * 0.5);
  });

  it('turns the bore inward, so a cylindrical zone cannot claim it', () => {
    /*
     * A cylindrical zone decides which surface it is on by radius, within a tolerance — and radius
     * alone is not enough to separate the bore from the skirt, because the *fillet* legitimately
     * sweeps through the same band on its way from the top face to the wall. What separates them is
     * which way they face: the skirt outward from the axis, the bore into the cavity.
     *
     * So the invariant this fixture has to hold is that every vertex at bore radius faces inward.
     */
    let bore = 0;
    for (let i = 0; i < cap.positions.length; i += 3) {
      const [x, z] = [cap.positions[i]!, cap.positions[i + 2]!];
      const radius = Math.hypot(x, z);
      if (radius < 1e-6 || Math.abs(radius - 17.5) > 0.01) continue;

      const outward = (cap.normals[i]! * x + cap.normals[i + 2]! * z) / radius;
      // Either it faces into the cavity, or it is a rim/ceiling vertex facing along the axis.
      expect(outward).toBeLessThan(0.5);
      if (outward < -0.5) bore++;
    }
    expect(bore).toBeGreaterThan(0);
  });

  it('keeps every vertex inside the declared radius and height', () => {
    for (let i = 0; i < cap.positions.length; i += 3) {
      const [x, y, z] = [cap.positions[i]!, cap.positions[i + 1]!, cap.positions[i + 2]!];
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(19.0001);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(18.0001);
    }
  });

  it('normalises its normals', () => {
    for (let i = 0; i < cap.normals.length; i += 3) {
      const length = Math.hypot(cap.normals[i]!, cap.normals[i + 1]!, cap.normals[i + 2]!);
      expect(length).toBeCloseTo(1, 5);
    }
  });

  it('maps uvs into the unit square', () => {
    for (const uv of cap.uvs!) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildCarton', () => {
  it('builds six quads', () => {
    expect(carton.indices.length).toBe(6 * 6);
    expect(carton.positions.length / 3).toBe(24);
  });

  it('sits on the ground plane and is centred horizontally', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < carton.positions.length; i += 3) {
      xs.push(carton.positions[i]!);
      ys.push(carton.positions[i + 1]!);
    }
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(120);
    expect(Math.min(...xs)).toBe(-40);
    expect(Math.max(...xs)).toBe(40);
  });

  it('gives the front panel its own uv island', () => {
    const us = [];
    for (let i = 0; i < 4 * 2; i += 2) us.push(carton.uvs![i]!);
    expect(Math.min(...us)).toBeCloseTo(0.02, 6);
    expect(Math.max(...us)).toBeCloseTo(0.4, 6);
  });
});

describe('multi-mesh packs', () => {
  it('encodes several meshes into one container', () => {
    const { json } = parseGlb(encodeGlb([cap, carton]));
    expect(json.meshes).toHaveLength(2);
    expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(['cap', 'carton']);
  });
});

describe('buildBottle', () => {
  const bottle = buildBottle({ radiusXMm: 30, radiusZMm: 20, heightMm: 110, segments: 96 });

  it('is oval in section, not round', () => {
    // The point of the fixture. Widest x and widest z must differ, or it is a bottle-shaped
    // cylinder and a flat projection would look fine on it.
    let maxX = 0;
    let maxZ = 0;
    for (let i = 0; i < bottle.positions.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(bottle.positions[i]!));
      maxZ = Math.max(maxZ, Math.abs(bottle.positions[i + 2]!));
    }
    expect(maxX).toBeCloseTo(30, 1);
    expect(maxZ).toBeCloseTo(20, 1);
  });

  it('curves in two directions at once, which is what makes it worth having', () => {
    /*
     * A developable surface — a plane, a cylinder, a cone — can be unrolled flat, and a zone on one
     * can be spaced by projecting a flat grid without anyone noticing. This fixture exists to be
     * the other case, so the test is that it genuinely is: walking *up* the flank at fixed angle,
     * the normal must turn, and walking *around* it at fixed height, the normal must turn too.
     */
    const normalAt = (index: number): [number, number, number] => [
      bottle.normals[index * 3]!,
      bottle.normals[index * 3 + 1]!,
      bottle.normals[index * 3 + 2]!,
    ];
    const angleBetween = (a: number[], b: number[]): number =>
      Math.acos(Math.min(1, Math.max(-1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)));

    const columns = 97; // segments + 1
    const bodyRingA = 12;
    const bodyRingB = 26;

    // Along the flank: the profile bellies, so the normal tilts off horizontal and back.
    const upTurn = angleBetween(normalAt(bodyRingA * columns), normalAt(bodyRingB * columns));
    expect(upTurn).toBeGreaterThan(0.01);

    // Around the flank: an ellipse turns its normal faster near the ends of the major axis.
    const around = angleBetween(normalAt(bodyRingA * columns), normalAt(bodyRingA * columns + 24));
    expect(around).toBeGreaterThan(0.5);
  });

  it('is closed: every edge is shared by exactly two triangles', () => {
    const key = (index: number): string => {
      const round = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Number(v.toFixed(4)));
      return `${round(bottle.positions[index * 3]!)},${round(bottle.positions[index * 3 + 1]!)},${round(
        bottle.positions[index * 3 + 2]!,
      )}`;
    };

    const uses = new Map<string, number>();
    for (let t = 0; t < bottle.indices.length; t += 3) {
      const corners = [key(bottle.indices[t]!), key(bottle.indices[t + 1]!), key(bottle.indices[t + 2]!)];
      for (let c = 0; c < 3; c++) {
        const from = corners[c]!;
        const to = corners[(c + 1) % 3]!;
        if (from === to) continue;
        const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
        uses.set(edge, (uses.get(edge) ?? 0) + 1);
      }
    }
    expect([...uses.values()].filter((n) => n !== 2)).toEqual([]);
  });

  it('normalises its normals and keeps uvs in the unit square', () => {
    for (let i = 0; i < bottle.normals.length; i += 3) {
      expect(Math.hypot(bottle.normals[i]!, bottle.normals[i + 1]!, bottle.normals[i + 2]!)).toBeCloseTo(1, 4);
    }
    for (const uv of bottle.uvs!) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
  });
});

describe('every solid faces outwards', () => {
  /*
   * The invariant `buildBottle` broke, and the one the existing volume check cannot see.
   *
   * That check takes `Math.abs(volume)`, so it measures how much a mesh encloses and not which way
   * round it is — an inside-out solid passes it unchanged. Nothing else caught it either: the
   * closure test compares edge counts, which is winding-agnostic, and product materials are
   * double-sided (a deliberate choice, so an open shell degrades to an odd interior rather than a
   * see-through product), so an inverted part still draws.
   *
   * What it could not hide: three.js flips the shading normal on a back face. The bottle shaded
   * with an inverted normal, the relief patch over its zone — a separate, correctly wound mesh —
   * did not, and the disagreement showed up as a rectangle of subtly wrong shading around the
   * artwork. It took a normals-as-colour render to see: inside the zone the normal read
   * (+0.51, +0.03, +0.85), pointing at the camera; a few pixels outside it read (-0.25, -0.03,
   * -0.97), pointing away.
   */
  type Solid = { positions: Float32Array; normals: Float32Array; indices: Uint32Array };

  /** Signed volume by the divergence theorem: positive when the winding faces out. */
  function signedVolume(m: Solid): number {
    let volume = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const at = (i: number): [number, number, number] => [
        m.positions[i * 3]!,
        m.positions[i * 3 + 1]!,
        m.positions[i * 3 + 2]!,
      ];
      const [ax, ay, az] = at(m.indices[t]!);
      const [bx, by, bz] = at(m.indices[t + 1]!);
      const [cx, cy, cz] = at(m.indices[t + 2]!);
      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return volume;
  }

  /** The share of triangles whose winding agrees with the normals the builder stored. */
  function windingAgreement(m: Solid): number {
    let agree = 0;
    let total = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [ia, ib, ic] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
      const at = (i: number): [number, number, number] => [
        m.positions[i * 3]!,
        m.positions[i * 3 + 1]!,
        m.positions[i * 3 + 2]!,
      ];
      const [ax, ay, az] = at(ia);
      const [bx, by, bz] = at(ib);
      const [cx, cy, cz] = at(ic);
      const [ux, uy, uz] = [bx - ax, by - ay, bz - az];
      const [wx, wy, wz] = [cx - ax, cy - ay, cz - az];
      const face: [number, number, number] = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
      if (Math.hypot(...face) < 1e-9) continue; // degenerate at a fan's apex; says nothing either way
      const dot =
        face[0] * m.normals[ia * 3]! + face[1] * m.normals[ia * 3 + 1]! + face[2] * m.normals[ia * 3 + 2]!;
      if (dot > 0) agree++;
      total++;
    }
    return total === 0 ? 1 : agree / total;
  }

  const solids: [string, Solid][] = [
    ['cap', cap],
    ['carton', carton],
    ['bottle', buildBottle({ radiusXMm: 30, radiusZMm: 20, heightMm: 110, segments: 96 })],
  ];

  it.each(solids)('%s encloses a positive volume', (_name, solid) => {
    // Negative means the whole part is inside-out. The bottle measured -148805 mm³ before the fix.
    expect(signedVolume(solid)).toBeGreaterThan(0);
  });

  it.each(solids)('%s winds its triangles to match the normals it stored', (_name, solid) => {
    // Not "most of them": a builder either got this right or it did not. The bottle scored 0%.
    expect(windingAgreement(solid)).toBeGreaterThan(0.999);
  });
});
