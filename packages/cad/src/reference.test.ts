import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeCadImporter } from './conformance.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { referenceImporter, segmentsFor } from './reference.js';
import { validateImportResult } from './validate.js';

const STEP = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('a closure'),'2;1');
FILE_NAME('closure-38.step','2026-03-11T09:14:22+01:00',('eng'),('Northfield'),'','FreeCAD','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
`;

const root = await mkdtemp(join(tmpdir(), 'pr-cad-fixture-'));
const stepPath = join(root, 'closure.step');
await writeFile(stepPath, STEP);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// The reference importer is what the conformance suite is checked against, so the suite is known
// to fail for the right reasons before a real kernel is ever pointed at it.
describeCadImporter({
  name: 'reference',
  make: () => referenceImporter(),
  fixture: () => ({ path: stepPath, format: 'step' as const }),
});

async function withDirs<T>(fn: (dirs: { out: string; scratch: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pr-cad-run-'));
  const dirs = { out: join(dir, 'out'), scratch: join(dir, 'scratch') };
  try {
    for (const path of Object.values(dirs)) await mkdir(path, { recursive: true });
    return await fn(dirs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const request = (dirs: { out: string; scratch: string }, sourcePath = stepPath) => ({
  sourcePath,
  format: 'step' as const,
  assumeUnit: 'mm' as const,
  lods: DEFAULT_BUDGETS.map((budget) => ({ ...budget })),
  outputDir: dirs.out,
  scratchDir: dirs.scratch,
  timeoutSec: 60,
});

describe('referenceImporter', () => {
  it('produces a result the validator accepts, with meshes on disk', async () => {
    await withDirs(async (dirs) => {
      const result = await referenceImporter().import(request(dirs));

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      expect(result.meshes.map((mesh) => mesh.lod)).toEqual(['lod0', 'lod1', 'render']);
      expect(result.symmetryAxis).toEqual([0, 1, 0]);
      const issues = await validateImportResult(result, {
        readMesh: (fileName) => readFile(join(dirs.out, fileName)),
      });
      expect(issues).toEqual([]);
    });
  });

  it('gets denser as the LOD gets finer', async () => {
    await withDirs(async (dirs) => {
      const result = await referenceImporter().import(request(dirs));
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      const triangles = result.meshes.map((mesh) => mesh.triangles);
      expect(triangles[1]!).toBeGreaterThan(triangles[0]!);
      expect(triangles[2]!).toBeGreaterThan(triangles[1]!);
    });
  });

  it('refuses a STEP file whose schema is not solid geometry', async () => {
    await withDirs(async (dirs) => {
      const path = join(dirs.scratch, 'electronics.step');
      await writeFile(path, STEP.replace(/FILE_SCHEMA\(\([^)]*\)\)/, "FILE_SCHEMA(('AP210_ELECTRONIC_ASSEMBLY'))"));

      const result = await referenceImporter().import(request(dirs, path));
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.failure).toBe('unsupported_schema');
    });
  });

  it('refuses a file whose content is not the format the caller claimed', async () => {
    // The supervisor already sniffed. Sniffing again is not distrust of the supervisor but of the
    // path between them, and it is what keeps a parser from being handed the wrong grammar.
    await withDirs(async (dirs) => {
      const path = join(dirs.scratch, 'lying.step');
      await writeFile(path, 'solid part\n facet normal 0 0 1\n endfacet\nendsolid part\n');

      const result = await referenceImporter().import(request(dirs, path));
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.failure).toBe('unsupported_format');
    });
  });

  it('reports itself unavailable rather than pretending', async () => {
    const probe = await referenceImporter({ available: false }).probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/\S/);
  });

  it('gives different files different geometry', async () => {
    // Determinism is only interesting alongside this: an importer that produced the same mesh for
    // every input would pass a two-run digest check and be useless.
    await withDirs(async (dirs) => {
      const other = join(dirs.scratch, 'other.step');
      await writeFile(other, STEP.replace('closure-38.step', 'closure-28.step'));

      const a = await referenceImporter().import(request(dirs));
      await rm(join(dirs.out, 'lod0.glb'));
      const b = await referenceImporter().import(request({ ...dirs, out: dirs.out }, other));

      expect(a.status === 'ok' && b.status === 'ok').toBe(true);
      if (a.status !== 'ok' || b.status !== 'ok') return;
      expect(a.bboxMm).not.toEqual(b.bboxMm);
    });
  });
});

describe('segmentsFor', () => {
  it('turns a chord tolerance into a segment count', () => {
    // An N-gon inscribed in a circle of radius R sits R·(1−cos(π/N)) inside it. The point of the
    // inverse is that an operator's millimetres reach the tessellator without a magic constant.
    const segments = segmentsFor({ name: 'x', deflectionMm: 0.05, angularDeg: 360, maxTriangles: 1e9 }, 19);
    const error = 19 * (1 - Math.cos(Math.PI / segments));
    expect(error).toBeLessThanOrEqual(0.05);
    expect(19 * (1 - Math.cos(Math.PI / (segments - 2)))).toBeGreaterThan(0.05);
  });

  it('takes the angular limit when it asks for more', () => {
    expect(segmentsFor({ name: 'x', deflectionMm: 5, angularDeg: 6, maxTriangles: 1e9 }, 19)).toBe(60);
  });

  it('does not ask for infinity when the tolerance is zero', () => {
    expect(segmentsFor({ name: 'x', deflectionMm: 0, angularDeg: 1, maxTriangles: 1e9 }, 19)).toBe(2048);
  });
});
