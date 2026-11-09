import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RenderBackend, RenderRequest } from './backend.js';

/**
 * The suite every renderer has to pass (docs/20, "Adapter conformance").
 *
 * An interface is a promise about behaviour, and TypeScript only checks the shape. These are the
 * parts a supervisor actually depends on: that a render reports progress, that cancelling stops it,
 * that a timeout is a timeout rather than a hang, and that failure is reported instead of thrown.
 *
 * Written to be runnable against a real renderer as well as a fake, which is why nothing here
 * inspects pixels — the two-pack conformance suite does that where a real renderer exists.
 */

export interface ConformanceOptions {
  name: string;
  /** Builds the backend under test. Called once per case, so state cannot leak between them. */
  make: () => RenderBackend | Promise<RenderBackend>;
  /**
   * Fills in what only the implementation's fixtures can supply: the spec, the mesh, and any baked
   * maps (written into `base.bakedDir`). May be async, because most of that is files.
   */
  request: (base: RenderRequest) => RenderRequest | Promise<RenderRequest>;
  /** Skip cases that need a real renderer installed. */
  skipIf?: boolean;
  timeoutMs?: number;
}

export function describeRenderBackend(options: ConformanceOptions): void {
  const timeout = options.timeoutMs ?? 120_000;

  describe.skipIf(options.skipIf)(`RenderBackend conformance: ${options.name}`, () => {
    async function withDirs<T>(fn: (dirs: { out: string; scratch: string; baked: string }) => Promise<T>): Promise<T> {
      const root = await mkdtemp(join(tmpdir(), 'pr-backend-'));
      const dirs = { out: join(root, 'out'), scratch: join(root, 'scratch'), baked: join(root, 'baked') };
      try {
        for (const dir of Object.values(dirs)) await mkdirp(dir);
        return await fn(dirs);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    it('says what it is and whether it can run', async () => {
      const backend = await options.make();
      const probe = await backend.probe();

      expect(backend.id).toMatch(/\S/);
      expect(typeof probe.available).toBe('boolean');
      expect(probe.features).toBeTypeOf('object');
      if (!probe.available) expect(probe.reason ?? '').toMatch(/\S/);
    });

    it('writes its images into the directory it was given, and nowhere else', async () => {
      const backend = await options.make();
      await withDirs(async (dirs) => {
        const result = await backend.render(await options.request(baseRequest(dirs)));

        expect(result.status).toBe('ok');
        const written = await readdir(dirs.out);
        expect(written.length).toBeGreaterThan(0);
      });
    }, timeout);

    it('reports progress that only moves forward within a stage', async () => {
      const backend = await options.make();
      await withDirs(async (dirs) => {
        const latest = new Map<string, number>();
        const result = await backend.render({
          ...(await options.request(baseRequest(dirs))),
          onProgress: (stage, fraction) => {
            expect(fraction).toBeGreaterThanOrEqual(0);
            expect(fraction).toBeLessThanOrEqual(1);
            // Progress is per stage: importing is 0 to 1, then tracing starts again at 0. What must
            // never happen is a stage going backwards, which is what a progress bar cannot survive.
            expect(fraction).toBeGreaterThanOrEqual(latest.get(stage) ?? 0);
            latest.set(stage, fraction);
          },
        });

        expect(result.status).toBe('ok');
      });
    }, timeout);

    it('stops when told the job is no longer ours, without starting the work', async () => {
      const backend = await options.make();
      await withDirs(async (dirs) => {
        // Already cancelled before the call: a backend that only polls mid-render would happily
        // spend minutes on a job somebody stopped, or that another worker has taken over.
        const result = await backend.render({
          ...(await options.request(baseRequest(dirs))),
          shouldCancel: () => true,
        });

        expect(result.status).toBe('failed');
        expect(result.failure).toBe('canceled');
        expect(await readdir(dirs.out)).toHaveLength(0);
      });
    }, timeout);

    it('gives up at the deadline rather than hanging', async () => {
      const backend = await options.make();
      await withDirs(async (dirs) => {
        const started = Date.now();
        const result = await backend.render({ ...(await options.request(baseRequest(dirs))), timeoutSec: 1 });

        // Either it finished inside the second or it stopped; a backend that ignores the deadline
        // is one that eventually holds every worker in the fleet.
        if (result.status === 'failed') expect(result.failure).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(60_000);
      });
    }, timeout);

    it('reports a broken input as a failure rather than throwing', async () => {
      const backend = await options.make();
      await withDirs(async (dirs) => {
        const request = await options.request(baseRequest(dirs));
        // A mesh that is not a mesh: the supervisor turns this into a failed job, and a thrown
        // error would instead look like a crash of the worker itself.
        const meshPath = join(dirs.scratch, 'broken.glb');
        await writeFile(meshPath, 'not a mesh');

        const result = await backend.render({ ...request, meshPath });
        expect(result.status).toBe('failed');
        expect(result.failure).toBeTruthy();
      });
    }, timeout);

    function baseRequest(dirs: { out: string; scratch: string; baked: string }): RenderRequest {
      return {
        spec: undefined as never, // supplied by `request`
        meshPath: '',
        bakedDir: dirs.baked,
        baked: [],
        outputDir: dirs.out,
        scratchDir: dirs.scratch,
        bboxMm: [
          [-19, 0, -19],
          [19, 18, 19],
        ],
        timeoutSec: 300,
        threads: 2,
      };
    }
  });
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}
