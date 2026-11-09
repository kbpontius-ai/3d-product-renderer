import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RenderRequest } from './backend.js';
import { describeRenderBackend } from './conformance.js';
import { fakeBackend } from './fake.js';

/**
 * The conformance suite, run against the fake.
 *
 * This is what keeps the suite honest: a set of cases nothing passes is not a contract, and a real
 * renderer failing them should mean the renderer is wrong rather than the cases being impossible.
 */

/** The smallest thing the contract will accept as a spec: one image, nothing placed. */
const spec = (): RenderRequest['spec'] =>
  ({
    specVersion: 1,
    document: {
      schemaVersion: 1,
      units: 'mm',
      product: { packKey: 'p', packVersion: '1.0.0', productKey: 'x', variantKey: 'y' },
      materials: {},
      placements: [],
      scene: {},
      annotations: {},
    },
    resolved: {
      meshKey: 'mesh.glb',
      meshDigest: '0'.repeat(64),
      bboxMm: [
        [-19, 0, -19],
        [19, 18, 19],
      ],
      zones: [],
      artwork: [],
      materials: [],
    },
    outputs: [
      {
        kind: 'image',
        widthPx: 16,
        heightPx: 16,
        format: 'png16',
        camera: { kind: 'preset', presetKey: 'three-quarter' },
      },
    ],
    quality: { preset: 'draft', samples: 16, denoiser: 'oidn', maxBounces: 4 },
    limits: { maxWallClockSec: 600 },
    renderer: { id: 'fake', version: '1' },
    seed: 1,
  }) as unknown as RenderRequest['spec'];

/** A file that starts like a GLB, because that is what the fake checks. */
async function writeMesh(dir: string): Promise<string> {
  const path = join(dir, 'mesh.glb');
  await writeFile(path, Buffer.concat([Buffer.from('glTF', 'ascii'), Buffer.alloc(64)]));
  return path;
}

describeRenderBackend({
  name: 'fake',
  make: () => fakeBackend({ msPerOutput: 20 }),
  request: async (base) => ({ ...base, spec: spec(), meshPath: await writeMesh(base.scratchDir) }),
  timeoutMs: 20_000,
});

describe('fakeBackend', () => {
  it('writes a PNG something else can actually read', async () => {
    const backend = fakeBackend();
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'pr-fake-'));

    const result = await backend.render({
      spec: spec(),
      meshPath: await writeMesh(root),
      bakedDir: root,
      baked: [],
      outputDir: root,
      scratchDir: root,
      bboxMm: [
        [-19, 0, -19],
        [19, 18, 19],
      ],
      timeoutSec: 60,
    });

    expect(result.status).toBe('ok');
    const png = await readFile(join(root, '00.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // Width and height are in the IHDR, where a reader looks for them.
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
  });

  it('says it cannot run when it cannot, rather than pretending', async () => {
    const backend = fakeBackend({ available: false });

    expect(await backend.probe()).toMatchObject({ available: false });
    const result = await backend.render({} as RenderRequest);
    expect(result).toMatchObject({ status: 'failed', failure: 'renderer_unavailable' });
  });
});
