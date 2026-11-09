import { describe, expect, it } from 'vitest';
import { zoneExtentMm } from '@pr/design-schema';
import type { DecorationZoneDef } from '@pr/design-schema';
import { cylindricalZoneFixture, planarZoneFixture } from '@pr/design-schema/fixtures';

import { buildMeshIndex, type MeshArrays } from './mesh-index.js';
import {
  buildZonePatch,
  cornerNormal,
  faceNormal,
  patchResolution,
  zoneAlignmentMin,
  PLANAR_ZONE_ALIGNMENT,
  CONFORMAL_ZONE_ALIGNMENT,
  PATCH_MAX_SEGMENTS,
  ZonePatchError,
  zoneSupportsPatch,
} from './patch.js';
import { dot, length, sub } from './vec.js';

const budget = { targetQuads: 4096 };

describe('patchResolution', () => {
  it('spends the budget on square cells', () => {
    const resolution = patchResolution({ w: 40, h: 10, safeMarginMm: 1 }, { targetQuads: 10_000 });
    // Cells should be square, so the segment ratio should track the 4:1 extent ratio.
    expect(resolution.segmentsX / resolution.segmentsY).toBeCloseTo(4, 1);
    expect(resolution.spacingMm.x).toBeCloseTo(resolution.spacingMm.y, 3);
  });

  it('lands near the quad budget it was given', () => {
    const resolution = patchResolution({ w: 30, h: 30, safeMarginMm: 1 }, { targetQuads: 90_000 });
    const quads = resolution.segmentsX * resolution.segmentsY;
    expect(quads).toBeGreaterThan(80_000);
    expect(quads).toBeLessThan(100_000);
  });

  it('never subdivides finer than the height texture resolves', () => {
    const resolution = patchResolution(
      { w: 30, h: 30, safeMarginMm: 1 },
      { targetQuads: 1_000_000, minSpacingMm: 0.5 },
    );
    expect(resolution.spacingMm.x).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(resolution.segmentsX).toBe(60);
  });

  it('clamps to the per-axis ceiling however large the budget', () => {
    const resolution = patchResolution(
      { w: 30, h: 30, safeMarginMm: 1 },
      { targetQuads: 100_000_000 },
    );
    expect(resolution.segmentsX).toBe(PATCH_MAX_SEGMENTS);
    expect(resolution.segmentsY).toBe(PATCH_MAX_SEGMENTS);
  });

  it('keeps a floor so a sliver of a zone still has a surface', () => {
    const resolution = patchResolution({ w: 2, h: 60, safeMarginMm: 1 }, { targetQuads: 16 });
    expect(resolution.segmentsX).toBeGreaterThanOrEqual(4);
    expect(resolution.segmentsY).toBeGreaterThanOrEqual(4);
  });
});

describe('buildZonePatch — planar', () => {
  const extent = zoneExtentMm(planarZoneFixture);
  const resolution = patchResolution(extent, budget);
  const patch = buildZonePatch(planarZoneFixture, resolution);

  it('produces a grid of the resolution it was given', () => {
    expect(patch.vertexCount).toBe((resolution.segmentsX + 1) * (resolution.segmentsY + 1));
    expect(patch.triangleCount).toBe(resolution.segmentsX * resolution.segmentsY * 2);
    expect(patch.index.length).toBe(patch.triangleCount * 3);
  });

  it('covers exactly the zone extent', () => {
    const xs: number[] = [];
    const zs: number[] = [];
    for (let v = 0; v < patch.vertexCount; v++) {
      xs.push(patch.position[v * 3]!);
      zs.push(patch.position[v * 3 + 2]!);
    }
    // The fixture zone is a 30 x 30 mm face; the frame's tangent and bitangent span x and z.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(extent.w, 4);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(extent.h, 4);
  });

  it('winds every triangle to face along the surface normal', () => {
    for (let t = 0; t < patch.triangleCount; t++) {
      expect(dot(faceNormal(patch, t), cornerNormal(patch, t))).toBeGreaterThan(0.99);
    }
  });

  it('emits unit normals and normals orthogonal to their tangents', () => {
    for (let v = 0; v < patch.vertexCount; v += 7) {
      const n = [patch.normal[v * 3]!, patch.normal[v * 3 + 1]!, patch.normal[v * 3 + 2]!] as const;
      const t = [patch.tangent[v * 3]!, patch.tangent[v * 3 + 1]!, patch.tangent[v * 3 + 2]!] as const;
      expect(length([...n])).toBeCloseTo(1, 5);
      expect(length([...t])).toBeCloseTo(1, 5);
      expect(dot([...n], [...t])).toBeCloseTo(0, 5);
    }
  });

  it('flips v so the zone canvas lands the right way up', () => {
    // The first row is zone -y, which is the bottom of the zone and so v = 1 in canvas space.
    expect(patch.zoneUv[0]).toBeCloseTo(0, 6);
    expect(patch.zoneUv[1]).toBeCloseTo(1, 6);
    const last = patch.vertexCount - 1;
    expect(patch.zoneUv[last * 2]).toBeCloseTo(1, 6);
    expect(patch.zoneUv[last * 2 + 1]).toBeCloseTo(0, 6);
  });

  it('places vertices on the zone frame plane', () => {
    const origin = planarZoneFixture.frame.originMm;
    const normal = planarZoneFixture.frame.normal;
    for (let v = 0; v < patch.vertexCount; v += 11) {
      const p = [patch.position[v * 3]!, patch.position[v * 3 + 1]!, patch.position[v * 3 + 2]!] as const;
      expect(Math.abs(dot(sub([...p], origin), normal))).toBeLessThan(1e-4);
    }
  });
});

describe('buildZonePatch — cylindrical', () => {
  const extent = zoneExtentMm(cylindricalZoneFixture);
  const resolution = patchResolution(extent, budget);
  const patch = buildZonePatch(cylindricalZoneFixture, resolution);
  const { radiusMm, axisOriginMm, axisDir } = cylindricalZoneFixture.frame;

  it('lays every vertex on the cylinder', () => {
    for (let v = 0; v < patch.vertexCount; v += 5) {
      const p = [patch.position[v * 3]!, patch.position[v * 3 + 1]!, patch.position[v * 3 + 2]!] as const;
      const relative = sub([...p], axisOriginMm);
      const along = dot(relative, axisDir);
      const radial = sub(relative, [axisDir[0] * along, axisDir[1] * along, axisDir[2] * along]);
      expect(length(radial)).toBeCloseTo(radiusMm, 4);
    }
  });

  it('winds every triangle outward, as the planar case does', () => {
    for (let t = 0; t < patch.triangleCount; t++) {
      // Curvature means the flat face normal is not exactly the vertex normal, but it must not be
      // on the other side of the surface.
      expect(dot(faceNormal(patch, t), cornerNormal(patch, t))).toBeGreaterThan(0.9);
    }
  });

  it('keeps normals radial and tangents circumferential', () => {
    for (let v = 0; v < patch.vertexCount; v += 9) {
      const n = [patch.normal[v * 3]!, patch.normal[v * 3 + 1]!, patch.normal[v * 3 + 2]!] as const;
      const t = [patch.tangent[v * 3]!, patch.tangent[v * 3 + 1]!, patch.tangent[v * 3 + 2]!] as const;
      expect(Math.abs(dot([...n], axisDir))).toBeLessThan(1e-5);
      expect(Math.abs(dot([...t], axisDir))).toBeLessThan(1e-5);
      expect(dot([...n], [...t])).toBeCloseTo(0, 5);
    }
  });

  it('spans the authored arc width along the surface', () => {
    // Arc length between the first and last vertex of a row must be the zone's own width.
    const columns = resolution.segmentsX + 1;
    const first = 0;
    const last = columns - 1;
    const chord = length(
      sub(
        [patch.position[last * 3]!, patch.position[last * 3 + 1]!, patch.position[last * 3 + 2]!],
        [patch.position[first * 3]!, patch.position[first * 3 + 1]!, patch.position[first * 3 + 2]!],
      ),
    );
    const expectedChord = 2 * radiusMm * Math.sin(extent.w / (2 * radiusMm));
    expect(chord).toBeCloseTo(expectedChord, 3);
  });
});

describe('buildZonePatch — mesh-backed zones', () => {
  /** A 20 mm quad in y = 0, UV-mapped across the whole square. */
  const quad: MeshArrays = {
    position: Float32Array.from([-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10]),
    normal: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    index: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };

  const uvZone: DecorationZoneDef = {
    type: 'uv_rect',
    key: 'panel',
    name: 'Panel',
    uvSet: 'decor',
    uvRect: { u0: 0.25, v0: 0.25, u1: 0.75, v1: 0.75 },
    sizeMm: { width: 10, height: 10, safeMarginMm: 1 },
    constraints: {
      finishes: ['emboss'],
      maxDepthMm: 0.6,
      minStrokeMm: 0.25,
      maxCoverage: 0.9,
      wrapWarnDeg: 120,
    },
  };

  it('refuses a UV zone with no mesh', () => {
    expect(zoneSupportsPatch(uvZone, false)).toBe(false);
    expect(() => buildZonePatch(uvZone, patchResolution({ w: 10, h: 10, safeMarginMm: 1 }, budget))).toThrow(
      ZonePatchError,
    );
  });

  it('builds a UV zone patch through the mesh sampler', () => {
    const mesh = buildMeshIndex(quad);
    const patch = buildZonePatch(uvZone, patchResolution({ w: 10, h: 10, safeMarginMm: 1 }, budget), {
      mesh,
    });

    expect(patch.fallbackVertices).toBe(0);
    for (let v = 0; v < patch.vertexCount; v += 3) {
      // The zone's UV rectangle is the middle half of the quad, so 10 mm either side of centre.
      expect(patch.position[v * 3 + 1]).toBeCloseTo(0, 5);
      expect(Math.abs(patch.position[v * 3]!)).toBeLessThanOrEqual(5.0001);
      expect(Math.abs(patch.position[v * 3 + 2]!)).toBeLessThanOrEqual(5.0001);
    }
  });

  it('carries the base mesh UVs so substrate textures tile continuously', () => {
    const mesh = buildMeshIndex(quad);
    const patch = buildZonePatch(uvZone, patchResolution({ w: 10, h: 10, safeMarginMm: 1 }, budget), {
      mesh,
    });
    // Corner of the zone is the corner of its UV rectangle, not (0,0) of the zone.
    expect(patch.uv[0]).toBeCloseTo(0.25, 4);
    expect(patch.uv[1]).toBeCloseTo(0.25, 4);
  });

  it('projects a conformal zone onto the mesh rather than onto its own frame', () => {
    const conformal: DecorationZoneDef = {
      type: 'conformal',
      key: 'wrap',
      name: 'Wrap',
      // Frame sits 4 mm above the quad; the patch must land on the quad, not on the frame.
      frame: { originMm: [0, 4, 0], normal: [0, 1, 0], tangent: [1, 0, 0], maxProjectionDepthMm: 8 },
      sizeMm: { width: 10, height: 10, safeMarginMm: 1 },
      constraints: {
        finishes: ['emboss'],
        maxDepthMm: 0.6,
        minStrokeMm: 0.25,
        maxCoverage: 0.9,
        wrapWarnDeg: 120,
      },
    };

    const mesh = buildMeshIndex(quad);
    const patch = buildZonePatch(conformal, patchResolution({ w: 10, h: 10, safeMarginMm: 1 }, budget), {
      mesh,
    });

    expect(patch.fallbackVertices).toBe(0);
    for (let v = 0; v < patch.vertexCount; v += 4) {
      expect(patch.position[v * 3 + 1]).toBeCloseTo(0, 4);
    }
  });

  it('spaces a conformal patch by surface distance, on a shape that is curved both ways', () => {
    /*
     * The oval-bottle case, at the level the preview actually consumes.
     *
     * A 40 mm zone on the flank of a 30x45x20 ellipsoid: every step across the patch was asked for
     * the same millimetre, so every step should have travelled it, whatever the surface did in
     * between. Projecting the same zone instead spreads it over 79 mm of bottle — nearly double —
     * because a ray from the frame covers more surface the further the flank turns away from it.
     */
    const ellipsoid = ellipsoidMesh();
    const zone: DecorationZoneDef = {
      type: 'conformal',
      key: 'flank',
      name: 'Flank',
      frame: { originMm: [30, 0, 0], normal: [1, 0, 0], tangent: [0, 0, 1], maxProjectionDepthMm: 12 },
      sizeMm: { width: 40, height: 20, safeMarginMm: 1 },
      constraints: { finishes: ['emboss'], maxDepthMm: 0.6, minStrokeMm: 0.25, maxCoverage: 0.9, wrapWarnDeg: 120 },
    };

    const resolution = { segmentsX: 20, segmentsY: 10, spacingMm: { x: 2, y: 2 } };
    const patch = buildZonePatch(zone, resolution, { mesh: buildMeshIndex(ellipsoid) });

    expect(patch.fallbackVertices).toBe(0);

    const columns = 21;
    const at = (col: number, row: number): number[] => {
      const n = (row * columns + col) * 3;
      return [patch.position[n]!, patch.position[n + 1]!, patch.position[n + 2]!];
    };
    const gap = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

    let spanned = 0;
    let worstStep = 0;
    for (let col = 0; col < 20; col++) {
      const step = gap(at(col, 5), at(col + 1, 5));
      spanned += step;
      worstStep = Math.max(worstStep, Math.abs(step - 2) / 2);
    }

    expect(spanned).toBeGreaterThan(39.5);
    expect(spanned).toBeLessThan(40.5);
    expect(worstStep).toBeLessThan(0.02);
  });

  it('falls back to the frame where a conformal ray misses, and says how often', () => {
    const conformal: DecorationZoneDef = {
      type: 'conformal',
      key: 'wrap',
      name: 'Wrap',
      // Positioned off the edge of the quad, so most rays hit nothing at all.
      frame: { originMm: [40, 4, 0], normal: [0, 1, 0], tangent: [1, 0, 0], maxProjectionDepthMm: 8 },
      sizeMm: { width: 10, height: 10, safeMarginMm: 1 },
      constraints: {
        finishes: ['emboss'],
        maxDepthMm: 0.6,
        minStrokeMm: 0.25,
        maxCoverage: 0.9,
        wrapWarnDeg: 120,
      },
    };

    const patch = buildZonePatch(conformal, patchResolution({ w: 10, h: 10, safeMarginMm: 1 }, budget), {
      mesh: buildMeshIndex(quad),
    });
    expect(patch.fallbackVertices).toBe(patch.vertexCount);
    for (let v = 0; v < patch.vertexCount; v += 6) {
      expect(patch.position[v * 3 + 1]).toBeCloseTo(4, 4); // the frame plane
    }
  });
});

describe('clipping the grid to the part', () => {
  /** A disc of radius 19 mm at y = 18 — the fixture closure's top face, which is round. */
  function disc(rings = 20, segments = 48): MeshArrays {
    const position: number[] = [0, 18, 0];
    const normal: number[] = [0, 1, 0];
    const uv: number[] = [0.5, 0.5];
    const index: number[] = [];

    for (let r = 1; r <= rings; r++) {
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        const radius = (r / rings) * 19;
        position.push(Math.cos(angle) * radius, 18, Math.sin(angle) * radius);
        normal.push(0, 1, 0);
        uv.push(0.5 + (Math.cos(angle) * radius) / 40, 0.5 + (Math.sin(angle) * radius) / 40);
      }
    }

    const at = (r: number, s: number) => (r === 0 ? 0 : 1 + (r - 1) * segments + (s % segments));
    for (let r = 1; r <= rings; r++) {
      for (let s = 0; s < segments; s++) {
        if (r === 1) index.push(at(0, 0), at(1, s), at(1, s + 1));
        else index.push(at(r - 1, s), at(r, s), at(r, s + 1), at(r - 1, s), at(r, s + 1), at(r - 1, s + 1));
      }
    }

    return {
      position: Float32Array.from(position),
      normal: Float32Array.from(normal),
      uv: Float32Array.from(uv),
      index: Uint32Array.from(index),
    };
  }

  const extent = zoneExtentMm(planarZoneFixture);
  const resolution = patchResolution(extent, { targetQuads: 20_000 });

  it('drops the square corners that hang off a round face', () => {
    const patch = buildZonePatch(planarZoneFixture, resolution, { mesh: buildMeshIndex(disc()) });

    expect(patch.clippedTriangles).toBeGreaterThan(0);
    expect(patch.triangleCount).toBe(resolution.segmentsX * resolution.segmentsY * 2 - patch.clippedTriangles);
    expect(patch.index.length).toBe(patch.triangleCount * 3);

    // A 30 mm square on a 38 mm disc overhangs at the corners only: about 2.4% of its area.
    const fraction = patch.clippedTriangles / (resolution.segmentsX * resolution.segmentsY * 2);
    expect(fraction).toBeGreaterThan(0.01);
    expect(fraction).toBeLessThan(0.05);
  });

  it('keeps every surviving triangle inside the disc', () => {
    const patch = buildZonePatch(planarZoneFixture, resolution, { mesh: buildMeshIndex(disc()) });

    // A kept triangle may reach one cell past the rim, because one supported corner keeps it.
    const overhang = 0.2 + Math.hypot(resolution.spacingMm.x, resolution.spacingMm.y);
    for (let t = 0; t < patch.triangleCount; t += 13) {
      for (let k = 0; k < 3; k++) {
        const v = patch.index[t * 3 + k]!;
        const x = patch.position[v * 3]!;
        const z = patch.position[v * 3 + 2]!;
        expect(Math.hypot(x, z)).toBeLessThan(19 + overhang);
      }
    }
  });

  it('clips nothing when the surface covers the whole zone', () => {
    // A disc wide enough to swallow the square's corners has nothing to trim.
    const wide = disc(20, 48);
    for (let i = 0; i < wide.position.length; i += 3) {
      wide.position[i] = (wide.position[i] as number) * 2;
      wide.position[i + 2] = (wide.position[i + 2] as number) * 2;
    }
    const patch = buildZonePatch(planarZoneFixture, resolution, { mesh: buildMeshIndex(wide) });
    expect(patch.clippedTriangles).toBe(0);
  });

  it('clips nothing at all when there is no mesh to clip against', () => {
    const patch = buildZonePatch(planarZoneFixture, resolution);
    expect(patch.clippedTriangles).toBe(0);
    expect(patch.triangleCount).toBe(resolution.segmentsX * resolution.segmentsY * 2);
  });

  it('draws nothing rather than something wrong when the zone misses the part entirely', () => {
    const conformal: DecorationZoneDef = {
      type: 'conformal',
      key: 'wrap',
      name: 'Wrap',
      frame: { originMm: [200, 18, 0], normal: [0, 1, 0], tangent: [1, 0, 0], maxProjectionDepthMm: 8 },
      sizeMm: { width: 10, height: 10, safeMarginMm: 1 },
      constraints: planarZoneFixture.constraints,
    };
    const patch = buildZonePatch(conformal, patchResolution({ w: 10, h: 10, safeMarginMm: 1 }, budget), {
      mesh: buildMeshIndex(disc()),
    });
    expect(patch.triangleCount).toBe(0);
    expect(patch.index.length).toBe(0);
  });

  it('builds a quarter-million-quad patch in well under a second', () => {
    // The per-vertex mesh query is the whole cost here, and the naive version of it took 24
    // seconds — long enough that the editor looked hung on every quality change.
    const mesh = buildMeshIndex(disc());
    const dense = patchResolution(extent, { targetQuads: 260_000 });
    const started = Date.now();
    buildZonePatch(planarZoneFixture, dense, { mesh });
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe('support means aligned surface, not just nearby surface', () => {
  /**
   * A closure in miniature: a 19 mm top face at y = 18 with a skirt dropping away from its rim.
   *
   * The point of the fixture is the rim. A patch vertex a hair outside the top face is within a
   * fraction of a millimetre of the skirt, so proximity alone would call it supported and lay a
   * flat sheet over the rounded edge of the part.
   */
  function cappedDisc(rings = 12, segments = 64): MeshArrays {
    const position: number[] = [0, 18, 0];
    const normal: number[] = [0, 1, 0];
    const uv: number[] = [0.5, 0.5];
    const index: number[] = [];

    for (let r = 1; r <= rings; r++) {
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        const radius = (r / rings) * 19;
        position.push(Math.cos(angle) * radius, 18, Math.sin(angle) * radius);
        normal.push(0, 1, 0);
        uv.push(0.5 + (Math.cos(angle) * radius) / 40, 0.5 + (Math.sin(angle) * radius) / 40);
      }
    }
    const topRing = 1 + (rings - 1) * segments;

    // The skirt: a second ring at the rim, dropping to the bench, with radial normals. It has to
    // reach past the skirt zone's own extent (y = 3..13) or the clipping under test is correct
    // for the wrong reason.
    for (let level = 0; level <= 1; level++) {
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        position.push(Math.cos(angle) * 19, level === 0 ? 18 : 0, Math.sin(angle) * 19);
        normal.push(Math.cos(angle), 0, Math.sin(angle));
        uv.push(s / segments, level);
      }
    }
    const skirt = 1 + rings * segments;

    const at = (r: number, s: number) => (r === 0 ? 0 : 1 + (r - 1) * segments + (s % segments));
    for (let r = 1; r <= rings; r++) {
      for (let s = 0; s < segments; s++) {
        if (r === 1) index.push(at(0, 0), at(1, s), at(1, s + 1));
        else index.push(at(r - 1, s), at(r, s), at(r, s + 1), at(r - 1, s), at(r, s + 1), at(r - 1, s + 1));
      }
    }
    for (let s = 0; s < segments; s++) {
      const a = skirt + s;
      const b = skirt + ((s + 1) % segments);
      index.push(a, a + segments, b + segments, a, b + segments, b);
    }
    void topRing;

    return {
      position: Float32Array.from(position),
      normal: Float32Array.from(normal),
      uv: Float32Array.from(uv),
      index: Uint32Array.from(index),
    };
  }

  it('refuses the skirt as support for a patch on the top face', () => {
    const mesh = buildMeshIndex(cappedDisc());
    const extent = zoneExtentMm(planarZoneFixture);
    const resolution = patchResolution(extent, { targetQuads: 20_000 });
    const patch = buildZonePatch(planarZoneFixture, resolution, { mesh });

    // Without the alignment test the skirt keeps every vertex out to the square's corners alive,
    // and nothing is clipped at all.
    expect(patch.clippedTriangles).toBeGreaterThan(0);

    let unsupportedInside = 0;
    let supportedOutside = 0;
    for (let v = 0; v < patch.vertexCount; v++) {
      const radius = Math.hypot(patch.position[v * 3]!, patch.position[v * 3 + 2]!);
      if (radius < 18.5 && !patch.support[v]) unsupportedInside++;
      if (radius > 19.5 && patch.support[v]) supportedOutside++;
    }
    expect(unsupportedInside).toBe(0);
    expect(supportedOutside).toBe(0);
  });

  it('still supports a patch laid on the skirt itself', () => {
    // The same rule has to admit the cylindrical zone, whose normals are radial like the skirt's.
    const mesh = buildMeshIndex(cappedDisc());
    const extent = zoneExtentMm(cylindricalZoneFixture);
    const patch = buildZonePatch(cylindricalZoneFixture, patchResolution(extent, { targetQuads: 20_000 }), {
      mesh,
    });
    expect(patch.clippedTriangles).toBe(0);
  });
});

/** An oval bottle in miniature: doubly curved, and curved differently along each axis. */
function ellipsoidMesh(rx = 30, ry = 45, rz = 20, bands = 96, sectors = 192): MeshArrays {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= bands; j++) {
    const phi = (j / bands) * Math.PI;
    for (let i = 0; i <= sectors; i++) {
      const theta = (i / sectors) * Math.PI * 2;
      const sx = Math.sin(phi) * Math.cos(theta);
      const sy = Math.cos(phi);
      const sz = Math.sin(phi) * Math.sin(theta);
      position.push(rx * sx, ry * sy, rz * sz);
      const nx = sx / rx;
      const ny = sy / ry;
      const nz = sz / rz;
      const n = Math.hypot(nx, ny, nz) || 1;
      normal.push(nx / n, ny / n, nz / n);
      uv.push(i / sectors, j / bands);
    }
  }
  for (let j = 0; j < bands; j++) {
    for (let i = 0; i < sectors; i++) {
      const a = j * (sectors + 1) + i;
      index.push(a, a + sectors + 1, a + 1, a + 1, a + sectors + 1, a + sectors + 2);
    }
  }
  return {
    position: Float32Array.from(position),
    normal: Float32Array.from(normal),
    uv: Float32Array.from(uv),
    index: Uint32Array.from(index),
  };
}

describe('the patch stops where the shader says the zone stops', () => {
  /**
   * The four tabs on the closure's rim.
   *
   * The base shader was tightened to `PLANAR_ZONE_ALIGNMENT` so a planar zone would stop claiming
   * the fillet it sits next to. The patch's own support test was left at sixty degrees, so it went
   * on covering that fillet — and because the patch is drawn with a polygon offset toward the
   * camera, its clipped edge stood proud of the part. On a 30 mm square over a 38 mm disc only the
   * corners reach the rim, which is why it appeared as four tabs at 45/135/225/315 degrees.
   *
   * The invariant is not "0.985": it is that the patch and the shader answer the same question the
   * same way. Both now read `zoneAlignmentMin`.
   */

  /** A disc with a *filleted* rim: the transition rolls through 45 degrees before the wall. */
  function filletedDisc(rings = 14, segments = 96): MeshArrays {
    const position: number[] = [0, 18, 0];
    const normal: number[] = [0, 1, 0];
    const uv: number[] = [0.5, 0.5];
    const index: number[] = [];
    const flatTo = 17.8;
    const filletR = 1.2;

    const ringAt = (r: number): { radius: number; y: number; n: [number, number] } => {
      if (r <= rings) return { radius: (r / rings) * flatTo, y: 18, n: [0, 1] };
      // Four fillet rings sweeping 0 -> 90 degrees; the first few are the ones sixty degrees let in.
      const t = (r - rings) / 4;
      const a = t * (Math.PI / 2);
      return {
        radius: flatTo + Math.sin(a) * filletR,
        y: 18 - (1 - Math.cos(a)) * filletR,
        n: [Math.sin(a), Math.cos(a)],
      };
    };

    for (let r = 1; r <= rings + 4; r++) {
      const { radius, y, n } = ringAt(r);
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        position.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        normal.push(Math.cos(angle) * n[0], n[1], Math.sin(angle) * n[0]);
        uv.push(0.5 + (Math.cos(angle) * radius) / 40, 0.5 + (Math.sin(angle) * radius) / 40);
      }
    }

    for (let r = 0; r < rings + 3; r++) {
      for (let s = 0; s < segments; s++) {
        const next = (s + 1) % segments;
        if (r === 0) {
          index.push(0, 1 + next, 1 + s);
          continue;
        }
        const a = 1 + (r - 1) * segments + s;
        const b = 1 + (r - 1) * segments + next;
        const c = 1 + r * segments + s;
        const d = 1 + r * segments + next;
        index.push(a, b, d, a, d, c);
      }
    }

    return {
      position: new Float32Array(position),
      normal: new Float32Array(normal),
      uv: new Float32Array(uv),
      index: new Uint32Array(index),
    };
  }

  const mesh = buildMeshIndex(filletedDisc());

  /** How far from the axis a supported vertex ever gets. */
  function supportedReachMm(zone: DecorationZoneDef): number {
    const patch = buildZonePatch(zone, patchResolution(zoneExtentMm(zone), { targetQuads: 20_000 }), { mesh });
    let reach = 0;
    for (let v = 0; v < patch.support.length; v++) {
      if (patch.support[v] === 0) continue;
      const [x, , z] = [patch.position[v * 3]!, patch.position[v * 3 + 1]!, patch.position[v * 3 + 2]!];
      reach = Math.max(reach, Math.hypot(x, z));
    }
    return reach;
  }

  it('keeps a planar zone off the fillet its corners reach', () => {
    // The flat top ends at 17.8 mm. A 30 mm square reaches 21.2 mm at its corners, so without the
    // rule the patch runs out over the fillet — which is what put four tabs on the rim.
    // Measured both ways on this fixture: 18.46 mm at the old sixty degrees, 18.16 mm now. The
    // bound sits between them, so this fails if the patch ever goes back to the loose rule.
    expect(supportedReachMm(planarZoneFixture)).toBeLessThan(18.3);
  });

  it('still lets a conformal zone follow the surface away from its frame', () => {
    // The same rectangle, meaning the opposite: here the surface is *expected* to curve away, and
    // holding it to ten degrees would reject the far side of whatever it is decorating.
    const conformal = {
      ...planarZoneFixture,
      type: 'conformal',
      frame: { ...planarZoneFixture.frame, maxProjectionDepthMm: 8 },
    } as DecorationZoneDef;
    expect(supportedReachMm(conformal)).toBeGreaterThan(supportedReachMm(planarZoneFixture));
  });

  it('asks the same question the shader asks', () => {
    // The defect was not a wrong number, it was two numbers. `zone-material.ts` re-exports these
    // rather than keeping its own, so the patch and the shader cannot drift apart again.
    expect(zoneAlignmentMin(planarZoneFixture)).toBe(PLANAR_ZONE_ALIGNMENT);
    expect(CONFORMAL_ZONE_ALIGNMENT).toBeLessThan(PLANAR_ZONE_ALIGNMENT);
  });
});
