import { describe, expect, it } from 'vitest';
import { buildMeshIndex, type MeshArrays } from './mesh-index.js';
import { buildSurfaceGrid } from './surface-grid.js';

/**
 * Analytic surfaces, where the right answer is known in closed form.
 *
 * The whole point of walking the surface instead of projecting onto it is that distances come out
 * right on something that is not flat. That is only a claim worth making if it is checked against
 * shapes whose true distances can be written down: a plane (trivially exact), a cylinder (exact,
 * because it is developable) and a sphere (not developable, so the interesting case — bounded
 * distortion rather than none).
 */

/** A flat sheet in the y = 0 plane, normals +y. */
function plane(halfMm = 60, steps = 40): MeshArrays {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const x = -halfMm + (2 * halfMm * i) / steps;
      const z = -halfMm + (2 * halfMm * j) / steps;
      position.push(x, 0, z);
      normal.push(0, 1, 0);
      uv.push(i / steps, j / steps);
    }
  }
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const a = j * (steps + 1) + i;
      index.push(a, a + steps + 1, a + 1, a + 1, a + steps + 1, a + steps + 2);
    }
  }
  return { position: Float32Array.from(position), normal: Float32Array.from(normal), uv: Float32Array.from(uv), index: Uint32Array.from(index) };
}

/** A tube of radius R about the y axis: developable, so an honest walk is exactly isometric. */
function cylinder(R = 20, halfHeight = 40, around = 256, along = 40): MeshArrays {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= along; j++) {
    for (let i = 0; i <= around; i++) {
      const t = (i / around) * Math.PI * 2;
      position.push(R * Math.cos(t), -halfHeight + (2 * halfHeight * j) / along, R * Math.sin(t));
      normal.push(Math.cos(t), 0, Math.sin(t));
      uv.push(i / around, j / along);
    }
  }
  for (let j = 0; j < along; j++) {
    for (let i = 0; i < around; i++) {
      const a = j * (around + 1) + i;
      index.push(a, a + around + 1, a + 1, a + 1, a + around + 1, a + around + 2);
    }
  }
  return { position: Float32Array.from(position), normal: Float32Array.from(normal), uv: Float32Array.from(uv), index: Uint32Array.from(index) };
}

/** An ellipsoid — the oval-bottle case: doubly curved, and curved differently along each axis. */
function ellipsoid(rx = 30, ry = 45, rz = 20, bands = 128, sectors = 256): MeshArrays {
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
      // Ellipsoid normal: gradient of (x/rx)^2 + (y/ry)^2 + (z/rz)^2.
      const nx = sx / rx, ny = sy / ry, nz = sz / rz;
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
  return { position: Float32Array.from(position), normal: Float32Array.from(normal), uv: Float32Array.from(uv), index: Uint32Array.from(index) };
}

const nodeAt = (grid: ReturnType<typeof buildSurfaceGrid>, col: number, row: number): [number, number, number] => {
  const n = (row * grid.columns + col) * 3;
  return [grid.position[n]!, grid.position[n + 1]!, grid.position[n + 2]!];
};
const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe('buildSurfaceGrid', () => {
  it('reproduces a flat grid on a plane', () => {
    const grid = buildSurfaceGrid(buildMeshIndex(plane()), {
      originMm: [0, 0, 0],
      normal: [0, 1, 0],
      tangent: [1, 0, 0],
      widthMm: 20,
      heightMm: 20,
      segmentsX: 8,
      segmentsY: 8,
      maxProjectionDepthMm: 5,
    });

    expect(grid.strayNodes).toBe(0);
    expect(grid.maxMetric).toBeCloseTo(1, 3);
    // Corner to corner across a 20 mm zone is 20 mm each way.
    expect(dist(nodeAt(grid, 0, 4), nodeAt(grid, 8, 4))).toBeCloseTo(20, 2);
  });

  it('measures a true 20 mm along the circumference of a cylinder, not 20 mm of chord', () => {
    /*
     * The developable case, and the one that shows what the walk is for. A flat projection of a
     * 20 mm zone onto a 20 mm-radius tube spans 20 mm of *chord*, which is 20.2 mm of surface. The
     * walk spans 20 mm of surface, so its chord comes out shorter — and by exactly the amount the
     * geometry says it should: 2R·sin(halfArc) for a 20 mm arc on R = 20.
     */
    const R = 20;
    const grid = buildSurfaceGrid(buildMeshIndex(cylinder(R)), {
      originMm: [R, 0, 0],
      normal: [1, 0, 0],
      tangent: [0, 0, 1],
      widthMm: 20,
      heightMm: 10,
      segmentsX: 20,
      segmentsY: 10,
      maxProjectionDepthMm: 6,
    });

    expect(grid.strayNodes).toBe(0);

    const chord = dist(nodeAt(grid, 0, 5), nodeAt(grid, 20, 5));
    const expectedChord = 2 * R * Math.sin(20 / (2 * R));
    expect(chord).toBeCloseTo(expectedChord, 1);

    // Every node's own step is a true millimetre: a cylinder is developable, so no stretch at all.
    expect(grid.maxMetric).toBeLessThan(1.01);
  });

  it('keeps millimetres true on an ellipsoid, where a flat projection cannot', () => {
    /*
     * The oval-bottle case. Walk a 40 mm-wide zone around the flank of a 30x45x20 ellipsoid and
     * check the arc length between neighbouring nodes: each step was asked for 2 mm and each step
     * should have travelled 2 mm of surface, whatever the surface was doing.
     */
    const grid = buildSurfaceGrid(buildMeshIndex(ellipsoid()), {
      originMm: [30, 0, 0],
      normal: [1, 0, 0],
      tangent: [0, 0, 1],
      widthMm: 40,
      heightMm: 20,
      segmentsX: 20,
      segmentsY: 10,
      maxProjectionDepthMm: 10,
    });

    expect(grid.strayNodes).toBe(0);

    const stepMm = 40 / 20;
    let worst = 0;
    for (let row = 0; row <= 10; row++) {
      for (let col = 0; col < 20; col++) {
        const step = dist(nodeAt(grid, col, row), nodeAt(grid, col + 1, row));
        worst = Math.max(worst, Math.abs(step - stepMm) / stepMm);
      }
    }
    // Chord under-runs arc by O(step^2 * curvature); at 2 mm steps on these radii that is < 1%.
    expect(worst).toBeLessThan(0.02);
  });

  it('beats a flat projection on the same ellipsoid, and by a knowable margin', () => {
    /*
     * The comparison that justifies the feature. A frame projection spaces nodes evenly across the
     * *frame*; on a flank curving away from that frame each successive step covers more surface
     * than the last, so a 40 mm zone lays out well over 40 mm of bottle.
     */
    const mesh = buildMeshIndex(ellipsoid());
    const grid = buildSurfaceGrid(mesh, {
      originMm: [30, 0, 0],
      normal: [1, 0, 0],
      tangent: [0, 0, 1],
      widthMm: 40,
      heightMm: 20,
      segmentsX: 20,
      segmentsY: 10,
      maxProjectionDepthMm: 10,
    });

    // What the old sampler does: march the frame, drop each point straight down onto the part.
    let projectedArc = 0;
    let previous: readonly number[] | null = null;
    for (let col = 0; col <= 20; col++) {
      const z = -20 + (40 * col) / 20;
      const hit = mesh.projectAlong([40, 0, z], [-1, 0, 0], 40);
      expect(hit).not.toBeNull();
      if (previous) projectedArc += dist(previous, hit!.position);
      previous = hit!.position;
    }

    let walkedArc = 0;
    for (let col = 0; col < 20; col++) walkedArc += dist(nodeAt(grid, col, 5), nodeAt(grid, col + 1, 5));

    // The walk lays out the 40 mm it was asked for; the projection lays out appreciably more.
    expect(walkedArc).toBeGreaterThan(39.5);
    expect(walkedArc).toBeLessThan(40.5);
    expect(projectedArc).toBeGreaterThan(walkedArc * 1.05);
  });

  it('handles an odd segment count, which is the ordinary case', () => {
    /*
     * `patchResolution` spends its quad budget on square cells, so it hands back whatever segment
     * counts that implies — 176 x 137 for the bottle fixture's flank. A grid that assumed an even
     * count indexed row 68.5, wrote through fractional offsets and produced NaN positions, which
     * surfaced far away as "cannot normalize a zero-length vector" when the patch was finished.
     */
    const grid = buildSurfaceGrid(buildMeshIndex(cylinder(20)), {
      originMm: [20, 0, 0],
      normal: [1, 0, 0],
      tangent: [0, 0, 1],
      widthMm: 15,
      heightMm: 9,
      segmentsX: 11,
      segmentsY: 7,
      maxProjectionDepthMm: 6,
    });

    expect(grid.columns).toBe(12);
    expect(grid.rows).toBe(8);
    expect(grid.strayNodes).toBe(0);
    for (const value of grid.position) expect(Number.isFinite(value)).toBe(true);
    for (const value of grid.normal) expect(Number.isFinite(value)).toBe(true);

    // Still isometric on a developable surface, odd counts or not.
    let spanned = 0;
    for (let col = 0; col < 11; col++) spanned += dist(nodeAt(grid, col, 3), nodeAt(grid, col + 1, 3));
    expect(spanned).toBeCloseTo(15, 1);
  });

  it('marks nodes that walk off the part rather than inventing surface for them', () => {
    // A 200 mm zone on a 120 mm plane: the outer nodes have nowhere to land.
    const grid = buildSurfaceGrid(buildMeshIndex(plane(60)), {
      originMm: [0, 0, 0],
      normal: [0, 1, 0],
      tangent: [1, 0, 0],
      widthMm: 200,
      heightMm: 200,
      segmentsX: 20,
      segmentsY: 20,
      maxProjectionDepthMm: 4,
    });

    expect(grid.strayNodes).toBeGreaterThan(0);
    // The centre is still on the sheet, so the grid is usable where the part exists.
    expect(grid.support[10 * grid.columns + 10]).toBe(1);
  });
});
