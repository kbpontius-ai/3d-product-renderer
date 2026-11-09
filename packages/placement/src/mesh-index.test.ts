import { describe, expect, it } from 'vitest';

import { buildMeshIndex, MeshSampleError, type MeshArrays } from './mesh-index.js';
import { length, sub } from './vec.js';

/**
 * A unit-ish quad in the y = 0 plane, 20 mm on a side, UV-mapped to the whole [0,1] square.
 *
 *   (-10,0,-10) u0v0 ── (10,0,-10) u1v0
 *        │                    │
 *   (-10,0, 10) u0v1 ── (10,0, 10) u1v1
 */
function quad(): MeshArrays {
  return {
    position: Float32Array.from([-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10]),
    normal: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    index: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

/** A closed cylinder wall: radius 19 mm, height 20 mm, no caps. Enough to test wrapping surfaces. */
function cylinder(segments = 64): MeshArrays {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const radius = 19;

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const [cx, cz] = [Math.cos(theta), Math.sin(theta)];
    for (let j = 0; j <= 1; j++) {
      position.push(cx * radius, j === 0 ? -10 : 10, cz * radius);
      normal.push(cx, 0, cz);
      uv.push(i / segments, j);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  return {
    position: Float32Array.from(position),
    normal: Float32Array.from(normal),
    uv: Float32Array.from(uv),
    index: Uint32Array.from(index),
  };
}

describe('buildMeshIndex', () => {
  it('samples the surface at a UV', () => {
    const index = buildMeshIndex(quad());
    const centre = index.sampleByUv({ x: 0.5, y: 0.5 });

    expect(centre.position[0]).toBeCloseTo(0, 5);
    expect(centre.position[1]).toBeCloseTo(0, 5);
    expect(centre.position[2]).toBeCloseTo(0, 5);
    expect(centre.normal).toEqual([0, 1, 0]);
  });

  it('maps UV corners to the geometry corners', () => {
    const index = buildMeshIndex(quad());
    expect(index.sampleByUv({ x: 0, y: 0 }).position).toEqual([-10, 0, -10]);
    expect(index.sampleByUv({ x: 1, y: 1 }).position).toEqual([10, 0, 10]);
  });

  it('derives the tangent from the UV parameterisation, not a triangle edge', () => {
    // Both triangles of the quad share a UV frame, so +u is +x wherever it is sampled — which a
    // tangent taken from the first edge of each triangle would not be.
    const index = buildMeshIndex(quad());
    for (const uv of [
      { x: 0.25, y: 0.25 },
      { x: 0.75, y: 0.75 },
    ]) {
      const point = index.sampleByUv(uv);
      expect(point.tangent[0]).toBeCloseTo(1, 5);
      expect(point.tangent[1]).toBeCloseTo(0, 5);
      expect(point.tangent[2]).toBeCloseTo(0, 5);
    }
  });

  it('reports millimetres per UV unit', () => {
    // 20 mm across one UV unit.
    expect(buildMeshIndex(quad()).uvMetricAt({ x: 0.5, y: 0.5 })).toBeCloseTo(20, 4);
  });

  it('finds the UV at a world position', () => {
    const index = buildMeshIndex(quad());
    const uv = index.uvAtWorld([0, 0, 0]);
    expect(uv?.x).toBeCloseTo(0.5, 5);
    expect(uv?.y).toBeCloseTo(0.5, 5);
  });

  it('refuses a world position that is nowhere near the surface', () => {
    expect(buildMeshIndex(quad()).uvAtWorld([0, 50, 0], 1)).toBeNull();
  });

  it('projects a ray onto the surface', () => {
    const index = buildMeshIndex(quad());
    const hit = index.projectAlong([3, 8, -4], [0, -1, 0], 20);

    expect(hit).not.toBeNull();
    expect(hit!.position[0]).toBeCloseTo(3, 4);
    expect(hit!.position[1]).toBeCloseTo(0, 4);
    expect(hit!.position[2]).toBeCloseTo(-4, 4);
  });

  it('returns null when the ray misses or falls short', () => {
    const index = buildMeshIndex(quad());
    expect(index.projectAlong([50, 8, 0], [0, -1, 0], 20)).toBeNull();
    expect(index.projectAlong([0, 30, 0], [0, -1, 0], 5)).toBeNull();
  });

  it('finds the nearest point on the surface', () => {
    const index = buildMeshIndex(quad());
    const near = index.nearestSurface([2, 7, 2]);
    expect(near!.position[1]).toBeCloseTo(0, 4);
    expect(length(sub(near!.position, [2, 0, 2]))).toBeLessThan(1e-3);
  });

  it('clamps a world query to the surface edge rather than missing it', () => {
    // Outside the quad in x, so the closest point is on the boundary and not below the query.
    const near = buildMeshIndex(quad()).nearestSurface([40, 0, 0]);
    expect(near!.position[0]).toBeCloseTo(10, 4);
  });

  it('throws for a UV no triangle covers', () => {
    const index = buildMeshIndex(quad());
    expect(() => index.sampleByUv({ x: 5, y: 5 })).toThrow(MeshSampleError);
  });

  describe('on a curved surface', () => {
    const index = buildMeshIndex(cylinder());

    it('samples radially outward normals', () => {
      const point = index.sampleByUv({ x: 0, y: 0.5 });
      expect(point.position[0]).toBeCloseTo(19, 2);
      expect(point.normal[0]).toBeCloseTo(1, 2);
      expect(point.normal[1]).toBeCloseTo(0, 5);
    });

    it('keeps the tangent circumferential, not radial', () => {
      const point = index.sampleByUv({ x: 0.25, y: 0.5 });
      // At a quarter turn the surface point is on +z and the tangent must be perpendicular to it.
      const radial = [point.normal[0], point.normal[1], point.normal[2]] as const;
      const along = point.tangent;
      const alignment = radial[0] * along[0] + radial[1] * along[1] + radial[2] * along[2];
      expect(Math.abs(alignment)).toBeLessThan(1e-4);
    });

    it('projects an inward ray onto the near wall, not the far one', () => {
      const hit = index.projectAlong([40, 0, 0], [-1, 0, 0], 100);
      expect(hit!.position[0]).toBeCloseTo(19, 1);
    });

    it('reports a metric that reflects the unrolled circumference', () => {
      // One UV unit spans the full 2πr circumference in u and 20 mm in v; the area-based metric is
      // the geometric mean of the two, which is what a distortion warning should be reading.
      const metric = index.uvMetricAt({ x: 0.5, y: 0.5 });
      expect(metric).toBeGreaterThan(Math.sqrt(2 * Math.PI * 19 * 20) * 0.9);
      expect(metric).toBeLessThan(Math.sqrt(2 * Math.PI * 19 * 20) * 1.1);
    });
  });

  it('survives a mesh with no UVs', () => {
    const noUv: MeshArrays = { ...quad(), uv: undefined };
    const index = buildMeshIndex(noUv);
    expect(index.hasUvs).toBe(false);
    expect(index.uvAtWorld([0, 0, 0])).toBeNull();
    expect(index.nearestSurface([0, 1, 0])).not.toBeNull();
  });

  it('survives an empty mesh', () => {
    const index = buildMeshIndex({ position: new Float32Array(), normal: new Float32Array() });
    expect(index.triangleCount).toBe(0);
    expect(index.nearestSurface([0, 0, 0])).toBeNull();
    expect(index.projectAlong([0, 0, 0], [0, -1, 0], 10)).toBeNull();
  });

  it('falls back to the geometric normal when shading normals are degenerate', () => {
    const broken: MeshArrays = { ...quad(), normal: Float32Array.from(new Array(12).fill(0)) };
    const point = buildMeshIndex(broken).sampleByUv({ x: 0.5, y: 0.5 });
    expect(Math.abs(point.normal[1])).toBeCloseTo(1, 5);
  });
});
