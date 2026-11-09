import { describe, expect, it } from 'vitest';
import type { DecorationZoneDef } from '@pr/design-schema';

import { buildMeshIndex, type MeshArrays } from './mesh-index.js';
import { buildZonePatch, CONFORMAL_ZONE_ALIGNMENT, patchResolution } from './patch.js';
import { surfaceCoordinates } from './surface-coordinates.js';

/**
 * Checked against a hollow container whose right answers can be written down: a 75 mm radius
 * outer wall and a 73 mm inner one, about the y axis, tessellated the way CAD exports a cylinder —
 * full-height strips, so every vertex is 50 mm or more outside a 100 mm zone and the coordinate any
 * fragment inside the zone gets is interpolated from vertices that are not in it.
 */

const R = 75;
const INNER = 73;
const HALF_HEIGHT = 100;
const AROUND = 72; // 5 degrees a strip

function wall(
  radius: number,
  outward: boolean,
  out: { position: number[]; normal: number[]; index: number[] },
): void {
  const base = out.position.length / 3;
  for (let j = 0; j <= 1; j++) {
    for (let i = 0; i <= AROUND; i++) {
      const t = (i / AROUND) * Math.PI * 2;
      out.position.push(radius * Math.cos(t), j ? HALF_HEIGHT : -HALF_HEIGHT, radius * Math.sin(t));
      const s = outward ? 1 : -1;
      out.normal.push(s * Math.cos(t), 0, s * Math.sin(t));
    }
  }
  for (let i = 0; i < AROUND; i++) {
    const a = base + i;
    const b = a + AROUND + 1;
    if (outward) out.index.push(a, b, a + 1, a + 1, b, b + 1);
    else out.index.push(a, a + 1, b, a + 1, b + 1, b);
  }
}

function container(): MeshArrays {
  const out = { position: [] as number[], normal: [] as number[], index: [] as number[] };
  wall(R, true, out);
  wall(INNER, false, out);
  return {
    position: Float32Array.from(out.position),
    normal: Float32Array.from(out.normal),
    index: Uint32Array.from(out.index),
  };
}

/** A 100 mm square facing +z, on the front of the container: zone +x runs toward +x, +y is up. */
const zone: DecorationZoneDef = {
  type: 'conformal',
  key: 'face',
  name: 'Face',
  frame: { originMm: [0, 0, R], normal: [0, 0, 1], tangent: [1, 0, 0], maxProjectionDepthMm: 1 },
  sizeMm: { width: 100, height: 100, safeMarginMm: 1 },
  constraints: {
    finishes: ['deboss'],
    maxDepthMm: 0.6,
    minStrokeMm: 0.25,
    maxCoverage: 0.9,
    wrapWarnDeg: 120,
  },
};
const extent = { w: 100, h: 100 };

function setUp() {
  const mesh = container();
  const patch = buildZonePatch(
    zone,
    patchResolution({ ...extent, safeMarginMm: 1 }, { targetQuads: 10_000 }),
    {
      mesh: buildMeshIndex(mesh),
    },
  );
  const result = surfaceCoordinates(patch, extent, mesh, {
    alignmentMin: CONFORMAL_ZONE_ALIGNMENT,
  });
  return { mesh, patch, ...result };
}

/** Vertex index of the outer (or inner) wall at strip `i`, bottom (j = 0) or top (j = 1). */
const vertexAt = (wallIndex: 0 | 1, i: number, j: 0 | 1): number =>
  wallIndex * 2 * (AROUND + 1) + j * (AROUND + 1) + i;
const angleOf = (i: number): number => (i / AROUND) * Math.PI * 2;

describe('surfaceCoordinates', () => {
  it('measures along the surface, not across the chord, and reaches vertices far outside the zone', () => {
    const { coordinates } = setUp();

    // Every outer strip within 55 degrees of the front: up to 72 mm of arc either way.
    for (let i = 0; i <= AROUND; i++) {
      const t = angleOf(i);
      const fromFront = Math.PI / 2 - t;
      if (Math.abs(fromFront) > (55 * Math.PI) / 180) continue;
      for (const j of [0, 1] as const) {
        const v = vertexAt(0, i, j);
        expect(coordinates[v * 3 + 2], `strip ${i} is on the zone's surface`).toBe(1);
        // Zone +x runs toward +x, which is toward smaller angles on this cylinder.
        expect(coordinates[v * 3]!).toBeCloseTo(R * fromFront, 0);
        expect(Math.abs(coordinates[v * 3]! - R * fromFront)).toBeLessThan(0.6);
        // 100 mm above or below centre: half again the zone's own height, recovered exactly.
        expect(coordinates[v * 3 + 1]!).toBeCloseTo(j ? HALF_HEIGHT : -HALF_HEIGHT, 1);
      }
    }
  });

  it('is exact enough at the zone edge for the cut-outs to land on the letters', () => {
    const { coordinates } = setUp();
    /*
     * The case on the real part: a logo 78 mm wide. Its ends sit 39 mm of arc from the centre,
     * where a projection measures 37.3 mm of chord — 1.75 mm short. The strips nearest that arc
     * must read within a tenth of a millimetre of it.
     */
    for (let i = 0; i <= AROUND; i++) {
      const fromFront = Math.PI / 2 - angleOf(i);
      if (Math.abs(R * fromFront) > 45) continue;
      const v = vertexAt(0, i, 1);
      expect(Math.abs(coordinates[v * 3]! - R * fromFront)).toBeLessThan(0.1);
    }
  });

  it('leaves the back of the part, the inside of its wall and the far inside wall alone', () => {
    const { coordinates } = setUp();

    for (let i = 0; i <= AROUND; i++) {
      const fromBack = Math.abs(angleOf(i) - (3 * Math.PI) / 2);
      for (const j of [0, 1] as const) {
        // The inside of the wall the zone is on faces the other way.
        expect(coordinates[vertexAt(1, i, j) * 3 + 2]).toBe(0);
        // The back of the part faces away.
        if (fromBack < Math.PI / 4) expect(coordinates[vertexAt(0, i, j) * 3 + 2]).toBe(0);
      }
    }
    /*
     * The inside of the far wall faces +z, exactly as the zone does, and sits straight behind it:
     * the normal test passes it, and only the distance behind the patch keeps it out. Without that
     * the artwork would be printed on the inside of the back of the jar.
     */
    const farInside = vertexAt(1, Math.round((3 * AROUND) / 4), 1);
    expect(coordinates[farInside * 3 + 2]).toBe(0);
  });

  it('counts what it assigned', () => {
    const { coordinates, valid } = setUp();
    let counted = 0;
    for (let v = 2; v < coordinates.length; v += 3) counted += coordinates[v]!;
    expect(valid).toBe(counted);
    expect(valid).toBeGreaterThan(0);
  });

  it('agrees with the patch at its own nodes', () => {
    const { patch } = setUp();
    const nodes: MeshArrays = { position: patch.position, normal: patch.normal };
    const { coordinates } = surfaceCoordinates(patch, extent, nodes, {
      alignmentMin: CONFORMAL_ZONE_ALIGNMENT,
    });
    const { segmentsX, segmentsY } = patch.resolution;
    const columns = segmentsX + 1;
    for (let node = 0; node < patch.vertexCount; node += 37) {
      const i = node % columns;
      const j = (node - i) / columns;
      expect(coordinates[node * 3]!).toBeCloseTo((i / segmentsX - 0.5) * extent.w, 3);
      expect(coordinates[node * 3 + 1]!).toBeCloseTo((j / segmentsY - 0.5) * extent.h, 3);
      expect(coordinates[node * 3 + 2]).toBe(1);
    }
  });

  it('assigns nothing when the patch found no surface at all', () => {
    const { mesh, patch } = setUp();
    patch.support.fill(0);
    const result = surfaceCoordinates(patch, extent, mesh, {
      alignmentMin: CONFORMAL_ZONE_ALIGNMENT,
    });
    expect(result.valid).toBe(0);
    expect(result.coordinates.every((value) => value === 0)).toBe(true);
  });
});
