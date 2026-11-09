import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadFormat } from './formats.js';
import type { CadImporter, CadImportRequest, LodRequest } from './contract.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { validateImportResult } from './validate.js';

/**
 * The suite every CAD importer has to pass (docs/23-cad-ingestion.md).
 *
 * TypeScript checks the shape of `CadImporter`; this checks the promises the shape does not carry.
 * A supervisor depends on all of them: that progress is reported, that cancelling stops the work
 * before it starts, that a deadline is a deadline rather than a hang, that a bad file comes back as
 * a failure instead of a thrown error — and, uniquely here, that two runs of the same file produce
 * the same bytes, because render dedupe and every parity baseline are keyed on a mesh digest.
 *
 * Written to run against a real kernel as well as the reference importer, which is why nothing here
 * asserts on geometry. The golden-corpus suite is where a tessellator's output is judged; this is
 * where its manners are.
 */

export interface CadConformanceOptions {
  name: string;
  /** Builds the importer under test. Called once per case, so state cannot leak between them. */
  make: () => CadImporter | Promise<CadImporter>;
  /** A file this importer can genuinely import, and the format it is. */
  fixture: () => Promise<{ path: string; format: CadFormat }> | { path: string; format: CadFormat };
  /** Overrides the LOD ladder, for a kernel whose defaults are elsewhere. */
  lods?: readonly LodRequest[];
  /** Skip cases that need a kernel installed. */
  skipIf?: boolean;
  timeoutMs?: number;
}

export function describeCadImporter(options: CadConformanceOptions): void {
  const timeout = options.timeoutMs ?? 300_000;
  const lods = options.lods ?? DEFAULT_BUDGETS;

  describe.skipIf(options.skipIf)(`CadImporter conformance: ${options.name}`, () => {
    async function withDirs<T>(fn: (dirs: { out: string; scratch: string }) => Promise<T>): Promise<T> {
      const root = await mkdtemp(join(tmpdir(), 'pr-cad-'));
      const dirs = { out: join(root, 'out'), scratch: join(root, 'scratch') };
      try {
        for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
        return await fn(dirs);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    async function baseRequest(dirs: { out: string; scratch: string }): Promise<CadImportRequest> {
      const fixture = await options.fixture();
      return {
        sourcePath: fixture.path,
        format: fixture.format,
        assumeUnit: 'mm',
        lods: lods.map((lod) => ({ ...lod })),
        outputDir: dirs.out,
        scratchDir: dirs.scratch,
        timeoutSec: 300,
        threads: 2,
      };
    }

    it('says what it is, what it reads, and whether it can run', async () => {
      const importer = await options.make();
      const probe = await importer.probe();

      expect(importer.id).toMatch(/\S/);
      expect(importer.formats.length).toBeGreaterThan(0);
      expect(typeof probe.available).toBe('boolean');
      expect(probe.features).toBeTypeOf('object');
      if (!probe.available) expect(probe.reason ?? '').toMatch(/\S/);
      // Version is what pins determinism to a build. An available importer that will not say which
      // one it is cannot have its output attributed to anything.
      if (probe.available) expect(probe.version ?? '').toMatch(/\S/);
    });

    it('writes its meshes into the directory it was given, and nowhere else', async () => {
      const importer = await options.make();
      await withDirs(async (dirs) => {
        const result = await importer.import(await baseRequest(dirs));

        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;

        const written = await readdir(dirs.out);
        expect(written.sort()).toEqual(result.meshes.map((mesh) => mesh.fileName).sort());
        for (const mesh of result.meshes) {
          expect(mesh.fileName).not.toContain('/');
          expect(mesh.bytes).toBeGreaterThan(0);
        }
      });
    }, timeout);

    it('produces a result the validator accepts', async () => {
      const importer = await options.make();
      await withDirs(async (dirs) => {
        const result = await importer.import(await baseRequest(dirs));
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;

        // The check the pipeline itself runs before any of this becomes a pack. An importer that
        // passes every other case here and fails this one has produced something unusable.
        const issues = await validateImportResult(result, {
          readMesh: (fileName) => readFile(join(dirs.out, fileName)),
        });
        expect(issues).toEqual([]);
      });
    }, timeout);

    it('reports progress that only moves forward within a stage', async () => {
      const importer = await options.make();
      await withDirs(async (dirs) => {
        const latest = new Map<string, number>();
        const result = await importer.import({
          ...(await baseRequest(dirs)),
          onProgress: (stage, fraction) => {
            expect(fraction).toBeGreaterThanOrEqual(0);
            expect(fraction).toBeLessThanOrEqual(1);
            expect(fraction).toBeGreaterThanOrEqual(latest.get(stage) ?? 0);
            latest.set(stage, fraction);
          },
        });

        expect(result.status).toBe('ok');
        expect(latest.size).toBeGreaterThan(0);
      });
    }, timeout);

    it('stops when told the job is no longer ours, without starting the work', async () => {
      const importer = await options.make();
      await withDirs(async (dirs) => {
        const result = await importer.import({ ...(await baseRequest(dirs)), shouldCancel: () => true });

        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure).toBe('canceled');
        expect(await readdir(dirs.out)).toHaveLength(0);
      });
    }, timeout);

    it('gives up at the deadline rather than hanging', async () => {
      const importer = await options.make();
      await withDirs(async (dirs) => {
        const started = Date.now();
        const result = await importer.import({ ...(await baseRequest(dirs)), timeoutSec: 1 });

        if (result.status === 'failed') expect(result.failure).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(120_000);
      });
    }, timeout);

    it('reports a file that is not what it claims as a failure rather than throwing', async () => {
      const importer = await options.make();
      await withDirs(async (dirs) => {
        const request = await baseRequest(dirs);
        const sourcePath = join(dirs.scratch, 'not-cad.bin');
        await writeFile(sourcePath, 'this is not a solid model');

        const result = await importer.import({ ...request, sourcePath });
        expect(result.status).toBe('failed');
        if (result.status === 'failed') {
          // Which failure is the importer's business; that it is one of the file's failures rather
          // than the worker's is not, because only the second kind is worth a retry.
          expect(['unsupported_format', 'corrupt_file']).toContain(result.failure);
        }
      });
    }, timeout);

    it('produces the same bytes twice for the same file', async () => {
      const importer = await options.make();
      await withDirs(async (first) => {
        await withDirs(async (second) => {
          const a = await importer.import(await baseRequest(first));
          const b = await importer.import(await baseRequest(second));

          expect(a.status).toBe('ok');
          expect(b.status).toBe('ok');
          if (a.status !== 'ok' || b.status !== 'ok') return;

          // Both the claimed digests and the files on disk: an importer that hashes something other
          // than what it wrote would otherwise look deterministic here and not be.
          expect(digestsOf(a.meshes)).toEqual(digestsOf(b.meshes));
          for (const mesh of a.meshes) {
            expect(await hashFile(join(first.out, mesh.fileName))).toEqual(
              await hashFile(join(second.out, mesh.fileName)),
            );
          }
        });
      });
    }, timeout);

    it('refuses a mesh denser than the LOD allows instead of writing it', async () => {
      const importer = await options.make();
      await withDirs(async (dirs) => {
        const request = await baseRequest(dirs);
        const result = await importer.import({
          ...request,
          lods: request.lods.map((lod) => ({ ...lod, maxTriangles: 1 })),
        });

        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.failure).toBe('too_complex');
      });
    }, timeout);
  });
}

const digestsOf = (meshes: readonly { lod: string; digest: string }[]): Record<string, string> =>
  Object.fromEntries(meshes.map((mesh) => [mesh.lod, mesh.digest]));

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
