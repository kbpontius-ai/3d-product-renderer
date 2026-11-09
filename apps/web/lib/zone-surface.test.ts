import { describe, expect, it } from 'vitest';
import { buildMeshIndex, type MeshArrays } from '@pr/placement';
import { DecorationZoneDef } from '@pr/design-schema';
import { buildZoneSurface } from './zone-surface';
const zone = DecorationZoneDef.parse({
  type: 'conformal',
  key: 'flank',
  name: 'Flank',
  frame: { originMm: [30, 0, 0], normal: [1, 0, 0], tangent: [0, 0, 1], maxProjectionDepthMm: 12 },
  sizeMm: { width: 40, height: 20, safeMarginMm: 1 },
  constraints: {
    finishes: ['emboss'],
    maxDepthMm: 0.6,
    minStrokeMm: 0.25,
    maxCoverage: 0.9,
    wrapWarnDeg: 120,
  },
});
if (zone.type !== 'conformal') throw new Error('fixture');
const mesh = buildMeshIndex(ellipsoidMesh());
describe('surface-zone preview', () => {
  it('follows a doubly curved noncylindrical mesh, including its safe boundary', () => {
    const surface = buildZoneSurface(zone, mesh);
    expect(surface.report.unsupportedVertices).toBe(0);
    expect(surface.report.cornersOff).toBe(0);
    expect(surface.report.facesInto).toBe(false);
    expect(surface.patch.vertexCount).toBeGreaterThan(1000);
    const xs = surface.boundary.flat().map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(5);
    for (const point of [...surface.boundary.flat(), ...surface.safe.flat()]) {
      const nearest = mesh.nearestSurface(point, 1);
      expect(nearest).not.toBeNull();
      expect(Math.hypot(...point.map((v, i) => v - nearest!.position[i]!))).toBeLessThan(0.2);
    }
  });
  it('does not draw a flat fallback when the part is out of reach', () => {
    const surface = buildZoneSurface(
      { ...zone, frame: { ...zone.frame, originMm: [200, 0, 0] } },
      mesh,
    );
    expect(surface.patch.index.length).toBe(0);
    expect(surface.boundary).toEqual([]);
    expect(surface.safe).toEqual([]);
    expect(surface.centre).toBeNull();
    expect(surface.report.unsupportedVertices).toBe(surface.patch.vertexCount);
  });
  it('preserves the inward-facing warning', () => {
    expect(
      buildZoneSurface({ ...zone, frame: { ...zone.frame, normal: [-1, 0, 0] } }, mesh).report
        .facesInto,
    ).toBe(true);
  });
  it('clips and reports regions past an open edge', () => {
    const open = buildMeshIndex({
      position: Float32Array.from([30, -3, -3, 30, 3, -3, 30, 3, 3, 30, -3, 3]),
      normal: Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
      index: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    });
    const surface = buildZoneSurface(zone, open);
    expect(surface.report.unsupportedVertices).toBeGreaterThan(0);
    expect(surface.patch.index.length).toBeLessThan(64 * 64 * 6);
    expect(surface.report.cornersOff).toBe(4);
    expect(
      Array.from(surface.patch.index).every((vertex) => surface.patch.support[vertex]! >= 0.5),
    ).toBe(true);
  });
});
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
