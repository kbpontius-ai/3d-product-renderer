import { readFile, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import type { BackendProbe, RenderBackend, RenderRequest, RenderResult } from './backend.js';

/**
 * A renderer that does not render.
 *
 * It writes a flat image of the right size for every requested output, reports progress, honours
 * cancellation and the deadline, and fails on an input a real renderer would fail on. That is
 * enough to exercise the queue, the worker and the whole download path on a machine with no
 * renderer installed — and it is the thing the conformance suite is checked against, so the suite
 * is known to fail for the right reasons.
 *
 * Not a production backend, and it does not pretend to be: `id` says so, and the images it writes
 * are a single colour.
 */

export interface FakeBackendOptions {
  /** Milliseconds of pretend work per output, so cancellation and timeouts have something to hit. */
  msPerOutput?: number;
  available?: boolean;
}

export function fakeBackend(options: FakeBackendOptions = {}): RenderBackend {
  const msPerOutput = options.msPerOutput ?? 40;
  const available = options.available ?? true;

  return {
    id: 'fake',

    async probe(): Promise<BackendProbe> {
      return available
        ? { available: true, version: 'fake-1', features: { denoiser: false } }
        : { available: false, features: {}, reason: 'the fake renderer was configured as unavailable' };
    },

    async render(request: RenderRequest): Promise<RenderResult> {
      const started = Date.now();
      if (!available) {
        return { status: 'failed', failure: 'renderer_unavailable', message: 'no renderer', seconds: 0 };
      }

      // A real renderer fails on a mesh it cannot parse; so does this one, on the same input.
      try {
        const mesh = await readFile(request.meshPath);
        if (mesh.byteLength < 12 || mesh.subarray(0, 4).toString('ascii') !== 'glTF') {
          return { status: 'failed', failure: 'renderer_crash', message: 'the mesh could not be read', seconds: elapsed(started) };
        }
      } catch {
        return { status: 'failed', failure: 'asset_missing', message: 'no mesh at that path', seconds: elapsed(started) };
      }

      const outputs = request.spec.outputs.filter((output) => output.kind === 'image');
      for (const [index, output] of outputs.entries()) {
        if (await stopped(request)) {
          return { status: 'failed', failure: 'canceled', message: 'canceled', seconds: elapsed(started) };
        }
        if (elapsed(started) > request.timeoutSec) {
          return { status: 'failed', failure: 'timeout', message: 'took too long', seconds: elapsed(started) };
        }

        request.onProgress?.('trace', (index + 1) / (outputs.length + 1));
        await sleep(msPerOutput);

        const name = `${String(index).padStart(2, '0')}.png`;
        await writeFile(join(request.outputDir, name), flatPng(output.widthPx, output.heightPx));
      }

      request.onProgress?.('write', 1);
      return { status: 'ok', seconds: elapsed(started) };
    },
  };
}

const elapsed = (from: number): number => (Date.now() - from) / 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopped(request: RenderRequest): Promise<boolean> {
  return request.shouldCancel ? Boolean(await request.shouldCancel()) : false;
}

/**
 * A valid single-colour PNG of the requested size.
 *
 * Hand-assembled rather than pulled from a library: the point is that whatever reads the output —
 * the uploader, the gallery, an image tool — sees a real PNG, and that is nine chunks of maths
 * rather than a dependency.
 */
function flatPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = 0x33;
      raw[at + 1] = 0x3a;
      raw[at + 2] = 0x44;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
