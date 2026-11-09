/**
 * An importer with no CAD kernel behind it.
 *
 * `fakeBackend` is the model: it does the shape of the real work — sniffs the format, reads the
 * header, honours deflection, respects limits, cancels, times out, writes real GLB files and hashes
 * them — while the geometry it produces is parametric rather than tessellated from B-rep. That is
 * enough to exercise the queue, the worker, the validator and the pack drafting on a machine with
 * no OCCT installed, which describes CI and most laptops.
 *
 * It is also what the conformance suite is checked against, so the suite is known to fail for the
 * right reasons before a real kernel is ever pointed at it.
 *
 * Deterministic on purpose: the same bytes in produce the same bytes out, on any machine. Render
 * dedupe is keyed on a mesh digest, so an importer that wobbles invalidates the cache silently, and
 * the cheapest place to find that out is here.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCap, encodeGlb, type MeshData } from '@pr/gltf';
import type {
  CadImportFailure,
  CadImporter,
  CadImportOutcome,
  CadImportRequest,
  CadImportResult,
  CadMeshFile,
  CadPart,
  CadProbe,
  LodRequest,
} from './contract.js';
import { DEFAULT_LIMITS } from './contract.js';
import { sniffFormat } from './formats.js';
import { parseStepHeader, schemaSupported } from './step-header.js';

export interface ReferenceImporterOptions {
  /** Milliseconds of pretend work per LOD, so cancellation and deadlines have something to hit. */
  msPerLod?: number;
  available?: boolean;
}

/** The single part this importer reports, and therefore the single material its meshes carry. */
const PART_KEY = 'body';

const UV = { top: { u0: 0.02, v0: 0.02, u1: 0.48, v1: 0.98 }, skirt: { u0: 0.52, v0: 0.02, u1: 0.98, v1: 0.98 } };

export function referenceImporter(options: ReferenceImporterOptions = {}): CadImporter {
  const msPerLod = options.msPerLod ?? 5;
  const available = options.available ?? true;

  return {
    id: 'reference',
    formats: ['step', 'stl'],

    async probe(): Promise<CadProbe> {
      return available
        ? { available: true, version: 'reference-1', features: { heal: false, decimate: true, autoUv: false } }
        : { available: false, features: {}, reason: 'the reference importer was configured as unavailable' };
    },

    async import(request: CadImportRequest): Promise<CadImportOutcome> {
      const started = Date.now();
      const fail = (failure: CadImportFailure['failure'], message: string): CadImportFailure => ({
        status: 'failed',
        importerId: 'reference',
        failure,
        message,
        seconds: elapsed(started),
      });

      if (!available) return fail('importer_unavailable', 'no importer');

      let source: Buffer;
      try {
        source = await readFile(request.sourcePath);
      } catch {
        return fail('corrupt_file', 'the source file could not be read');
      }

      // The supervisor already sniffed; sniffing again is not distrust of the supervisor but of the
      // path between them — and it is how a mismatch between the claimed and actual format becomes
      // a refusal rather than a native parser reading the wrong grammar.
      const sniffed = sniffFormat(source);
      if (sniffed.format === null || sniffed.format !== request.format) {
        return fail('unsupported_format', `the file is not ${request.format}`);
      }

      let declaredUnit: string | null = null;
      if (sniffed.format === 'step') {
        const header = parseStepHeader(source.toString('latin1'));
        if (header.schemas.length === 0) return fail('corrupt_file', 'the STEP header declares no schema');
        if (!schemaSupported(header)) {
          return fail('unsupported_schema', `${header.schemas.join(', ')} is not an application protocol we import`);
        }
        // A real importer reads SI_UNIT out of the DATA section. This one does not parse geometry,
        // so it reports what the caller was willing to assume and says that it assumed it.
        declaredUnit = null;
      }

      const limits = request.limits ?? DEFAULT_LIMITS;
      // Everything about the shape comes from the file's digest, so it is stable across machines and
      // different between files — which is what makes a two-run determinism check meaningful.
      const digest = createHash('sha256').update(source).digest();
      const radiusMm = 12 + (digest[0]! % 24); // 12–35 mm: a closure, comfortably inside PLAUSIBLE_SIZE_MM
      const heightMm = 8 + (digest[1]! % 20);

      const meshes: CadMeshFile[] = [];
      let totalTriangles = 0;

      for (const [index, lod] of request.lods.entries()) {
        if (await stopped(request)) return fail('canceled', 'canceled');
        if (elapsed(started) > request.timeoutSec) return fail('timeout', 'took too long');

        request.onProgress?.('tessellate', (index + 1) / (request.lods.length + 1));
        await sleep(msPerLod);

        const mesh = buildCap({
          radiusMm,
          heightMm,
          filletMm: 1.2,
          segments: segmentsFor(lod, radiusMm),
          topUvRect: UV.top,
          skirtUvRect: UV.skirt,
          material: 0,
        });
        const triangles = mesh.indices.length / 3;
        totalTriangles += triangles;

        if (triangles > lod.maxTriangles || totalTriangles > limits.maxTrianglesTotal) {
          return fail('too_complex', `"${lod.name}" needs ${triangles} triangles, over what was allowed`);
        }

        meshes.push(await writeMesh(request.outputDir, lod.name, mesh, triangles));
      }

      request.onProgress?.('write', 1);

      const parts: CadPart[] = [
        {
          name: PART_KEY,
          parentIndex: null,
          bboxMm: [
            [-radiusMm, 0, -radiusMm],
            [radiusMm, heightMm, radiusMm],
          ],
          triangles: meshes.find((mesh) => mesh.lod === 'render')?.triangles ?? totalTriangles,
          volumeMm3: Math.PI * radiusMm * radiusMm * heightMm,
          watertight: false, // A cap is open underneath, and saying otherwise would be a lie a validator trusts.
        },
      ];

      const result: CadImportResult = {
        status: 'ok',
        importerId: 'reference',
        importerVersion: 'reference-1',
        format: sniffed.format,
        declaredUnit,
        unitAssumed: declaredUnit === null && request.assumeUnit !== undefined,
        bboxMm: parts[0]!.bboxMm,
        parts,
        repairs: [],
        meshes,
        symmetryAxis: [0, 1, 0], // A body of revolution about Y, which is what `buildCap` makes.
        seconds: elapsed(started),
      };

      return result;
    },
  };
}

/**
 * How many segments a chord tolerance implies, for a cylinder of this radius.
 *
 * A regular N-gon inscribed in a circle of radius R sits at most R·(1−cos(π/N)) inside it, so the
 * deflection the operator asked for turns into a segment count directly rather than through a
 * magic constant. The angular limit is the other half of the same request — a shallow fillet needs
 * segments the chord test would not ask for.
 */
export function segmentsFor(lod: LodRequest, radiusMm: number): number {
  const fromChord = Math.PI / Math.acos(Math.max(-1, Math.min(1, 1 - lod.deflectionMm / radiusMm)));
  const fromAngle = 360 / lod.angularDeg;
  // Even, so the seam lands on a vertex, and clamped so a zero deflection cannot ask for infinity.
  return Math.min(2048, Math.max(8, Math.ceil(Math.max(fromChord, fromAngle) / 2) * 2));
}

async function writeMesh(outputDir: string, lod: string, mesh: MeshData, triangles: number): Promise<CadMeshFile> {
  const fileName = `${lod}.glb`;
  // One material, named for the one part this importer reports. The pack's slots are matched to
  // these by position, so the two lists are built from the same place — see `slotKeysFor`.
  const glb = encodeGlb([mesh], [{ name: PART_KEY, roughnessFactor: 0.5 }]);
  await writeFile(join(outputDir, fileName), glb);

  return {
    lod,
    fileName,
    triangles,
    bytes: glb.byteLength,
    digest: createHash('sha256').update(glb).digest('hex'),
    // No authored decoration UVs: `buildCap` produces exactly the two islands a frame-based zone
    // does not need and a `uv_rect` zone does, and claiming otherwise would let the validator pass
    // a mesh no logo could be placed on.
    uvSets: ['auto'],
    materialKeys: [PART_KEY],
  };
}

const elapsed = (from: number): number => (Date.now() - from) / 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopped(request: CadImportRequest): Promise<boolean> {
  return request.shouldCancel ? Boolean(await request.shouldCancel()) : false;
}
