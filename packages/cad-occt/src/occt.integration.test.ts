import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGETS,
  draftPack,
  slotKeysFor,
  validateImportResult,
  describeCadImporter,
} from './testing-imports.js';
import { occtLocal } from './occt.js';

/**
 * The OCCT importer, against real STEP files (docs/23-cad-ingestion.md).
 *
 * Skipped where OCCT is not installed, which is the same bargain `@pr/blender`'s suite makes with
 * Cycles: the contract is proven against the reference importer everywhere, and against the kernel
 * wherever there is one.
 */

const FIXTURES = resolve('fixtures/cad');
const CLOSURE = join(FIXTURES, 'closure-38.step');
const LINED = join(FIXTURES, 'closure-lined.step');
const CARTON = join(FIXTURES, 'carton.step');
const CURVED = join(FIXTURES, 'curved-metrology.step');

const probe = await occtLocal().probe();
const withoutOcct = !probe.available;

if (withoutOcct) {
  // Said once, rather than as sixteen silent skips: a suite that quietly tests nothing is worse
  // than one that says it is not testing anything.
  console.warn(`skipping the OCCT suite: ${probe.reason ?? 'no kernel'}`);
}

describeCadImporter({
  name: 'occt',
  make: () => occtLocal(),
  fixture: () => ({ path: CLOSURE, format: 'step' as const }),
  skipIf: withoutOcct,
  timeoutMs: 300_000,
});

if (process.env['CI'] && withoutOcct) {
  throw new Error(`Required integration-test dependency is unavailable: ${probe.reason ?? 'probe failed'}`);
}

describe.skipIf(withoutOcct)('occt importer', () => {
  async function withDirs<T>(fn: (dirs: { out: string; scratch: string }) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), 'pr-occt-'));
    const dirs = { out: join(root, 'out'), scratch: join(root, 'scratch') };
    try {
      for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
      return await fn(dirs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const request = (dirs: { out: string; scratch: string }, sourcePath: string) => ({
    sourcePath,
    format: 'step' as const,
    assumeUnit: 'mm' as const,
    lods: DEFAULT_BUDGETS.map((budget) => ({ ...budget })),
    outputDir: dirs.out,
    scratchDir: dirs.scratch,
    timeoutSec: 240,
  });

  const importOne = async (sourcePath: string) =>
    withDirs(async (dirs) => {
      const result = await occtLocal().import(request(dirs, sourcePath));
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('import failed');
      const issues = await validateImportResult(result, {
        readMesh: (fileName) => readFile(join(dirs.out, fileName)),
      });
      return { result, issues, dirs };
    });

  it('measures a closure in millimetres and says which unit the file declared', async () => {
    const { result, issues } = await importOne(CLOSURE);

    expect(issues).toEqual([]);
    expect(result.declaredUnit).toBe('mm');
    expect(result.unitAssumed).toBe(false);
    // 38 mm across, 18 tall — the dimensions the file was built to, arriving without conversion.
    const [min, max] = result.bboxMm;
    expect(max[0] - min[0]).toBeCloseTo(38, 1);
    expect(max[1] - min[1]).toBeCloseTo(18, 1);
  }, 300_000);

  it('finds the axis a body of revolution turns about, and none on a box', async () => {
    // The axis seeds the pack's camera presets and decides whether "diameter" is a dimension the
    // catalog card can quote. Reporting one for a carton would put a diameter on a rectangle.
    const closure = await importOne(CLOSURE);
    const carton = await importOne(CARTON);

    expect(closure.result.symmetryAxis).toEqual([0, 1, 0]);
    expect(carton.result.symmetryAxis).toBeNull();
  }, 300_000);

  it('measures curved geometry without conservative boxes or spline volume drift', async () => {
    const { result, issues } = await importOne(CURVED);
    expect(issues).toEqual([]);
    expect(result.repairs).toEqual([]);
    const ring = result.parts.find((part) => part.name === 'Rounded ring');
    const loft = result.parts.find((part) => part.name === 'Twisted loft');
    expect(ring?.watertight).toBe(true);
    expect(loft?.watertight).toBe(true);
    expect(ring?.bboxMm[0]).toEqual([
      expect.closeTo(-12, 5), expect.closeTo(-12, 5), expect.closeTo(-2, 5),
    ]);
    expect(ring?.bboxMm[1]).toEqual([
      expect.closeTo(12, 5), expect.closeTo(12, 5), expect.closeTo(2, 5),
    ]);
    expect(ring?.volumeMm3).toBeCloseTo(80 * Math.PI ** 2, 4);
    // The synthetic loft's reference converges to this value at 1e-9 and 1e-11 integration
    // tolerances. Non-adaptive quadrature instead reports 1382.187309 mm³.
    expect(loft?.volumeMm3).toBeCloseTo(1382.225723681, 3);
  }, 300_000);

  it('keeps the names the CAD system gave the parts', async () => {
    // These become the pack's material slots. An importer that dropped them would turn every
    // assembly into one anonymous lump that nobody can colour separately.
    const { result } = await importOne(LINED);

    expect(result.parts.map((part) => part.name)).toEqual(['Cap body', 'Liner']);
    expect(result.parts.every((part) => part.watertight)).toBe(true);
    expect(result.parts.every((part) => (part.volumeMm3 ?? 0) > 0)).toBe(true);
  }, 300_000);

  it('names its materials exactly what the pack will name its slots', async () => {
    // The renderer matches slots to materials by position. This is the invariant that makes that
    // safe, checked here against a real assembly rather than a hand-written result.
    const { result, issues } = await importOne(LINED);

    expect(issues).toEqual([]);
    const expected = slotKeysFor(result.parts).map((slot) => slot.key);
    expect(expected).toEqual(['cap-body', 'liner']);
    for (const mesh of result.meshes) expect([...mesh.materialKeys]).toEqual(expected);
  }, 300_000);

  it('gets denser as the LOD gets finer, and stays inside the budgets', async () => {
    const { result, issues } = await importOne(LINED);

    expect(issues).toEqual([]);
    const triangles = result.meshes.map((mesh) => mesh.triangles);
    expect(triangles[1]!).toBeGreaterThan(triangles[0]!);
    expect(triangles[2]!).toBeGreaterThan(triangles[1]!);
  }, 300_000);

  it('produces a pack draft the schema and the invariant checker accept', async () => {
    // The whole point of the pipeline, checked against a kernel rather than a fake: a supplier's
    // file in, something the catalog can hold at the other end.
    const { result } = await importOne(LINED);
    const { manifest, todos } = draftPack(result, {
      packKey: 'northfield-closures',
      packName: 'Northfield closures',
      productKey: 'cap-flat',
      productName: 'Flat-top closure',
      category: 'closures',
      variantKey: '38mm',
    });

    const variant = manifest.products[0]!.variants[0]!;
    expect(variant.materialSlots.map((slot) => slot.key)).toEqual(['cap-body', 'liner']);
    expect(variant.dimensionsMm).toMatchObject({ diameter: expect.closeTo(38, 1) as unknown as number });
    expect(variant.zones).toEqual([]);
    expect(todos.map((todo) => todo.code)).toContain('zones_missing');
  }, 300_000);

  it('refuses a file that is not the format it was told', async () => {
    await withDirs(async (dirs) => {
      const path = join(dirs.scratch, 'not-step.step');
      await writeFile(path, 'solid part\n facet normal 0 0 1\n endfacet\nendsolid part\n');

      const result = await occtLocal().import(request(dirs, path));
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.failure).toBe('corrupt_file');
    });
  }, 300_000);

  it('reports an interpreter without OCCT as unavailable rather than crashing on a job', async () => {
    // A worker that claims jobs it cannot import burns every attempt and marks real work failed.
    // Refusing to start is the honest failure, and this is what tells it to.
    const probe = await occtLocal({ pythonPath: '/nonexistent/python' }).probe();

    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/\S/);
  });
});
