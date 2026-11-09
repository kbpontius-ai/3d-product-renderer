import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { referenceImporter, type CadImporter, type CadImportRequest } from '@pr/cad';
import {
  cancelIngestion,
  claimIngestion,
  getIngestion,
  submitIngestion,
  type CadClaim,
} from '@pr/cad-jobs';
import { Logger } from '@pr/observability';
import { localStorage, type Storage } from '@pr/storage';
import { outputKey, runIngestion } from './job.js';

/**
 * The ingestion supervisor (docs/23-cad-ingestion.md).
 *
 * Most of these are about the supervisor refusing things, which is the point of it. It stands
 * between a large native parser that has just read a stranger's file and the storage a customer's
 * catalog is built from, and every one of these cases is a way that boundary could be crossed by
 * something nobody meant to store.
 */

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

const PIPELINE = '2026.08.1';
const quiet = new Logger({ level: 'error', sink: () => {} });

describe.skipIf(!hasDatabase)('cad ingestion supervisor', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let storage: Storage;
  let storageRoot: string;
  let scratchRoot: string;

  const alpha = () => ({ orgId: orgs.alpha, userId: null });

  const deps = (over: Partial<Parameters<typeof runIngestion>[1]> = {}) => ({
    sql,
    storage,
    workerId: 'worker-1',
    scratchRoot,
    importer: referenceImporter(),
    maxSourceBytes: 8 * 1024 * 1024,
    timeoutSec: 60,
    log: quiet,
    ...over,
  });

  /** Puts a file in storage and queues an ingestion for it, as the admin upload route would. */
  async function queue(body: string | Uint8Array, name = 'closure-38.step'): Promise<CadClaim> {
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
    const key = `cad-source/${orgs.alpha}/${name}`;
    await storage.put(key, bytes, 'application/octet-stream');

    await submitIngestion(sql, alpha(), {
      sourceKey: key,
      sourceName: name,
      sourceBytes: bytes.byteLength,
      sourceDigest: createHash('sha256').update(bytes).digest(),
      format: 'step',
      pipelineVersion: PIPELINE,
    });

    return (await claimIngestion(sql, 'worker-1'))!;
  }

  beforeAll(async () => {
    db = await createTestDatabase('pr_cadw');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
    storageRoot = await mkdtemp(join(tmpdir(), 'pr-cad-store-'));
    scratchRoot = await mkdtemp(join(tmpdir(), 'pr-cad-scratch-'));
    storage = localStorage(storageRoot);
  });

  afterAll(async () => {
    await db.drop();
    await rm(storageRoot, { recursive: true, force: true });
    await rm(scratchRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withStaff(sql, async (tx) => {
      await tx`delete from cad_jobs`;
      await tx`delete from usage_events`;
    });
  });

  it('ingests a file and puts its meshes where the pack step will look', async () => {
    const claim = await queue(STEP);

    expect(await runIngestion(claim, deps())).toBe('succeeded');

    const job = await getIngestion(sql, alpha(), claim.jobId);
    expect(job.status).toBe('succeeded');
    expect(job.importerId).toBe('reference');
    expect(job.result?.meshes.map((mesh) => mesh.lod)).toEqual(['lod0', 'lod1', 'render']);

    for (const mesh of job.result!.meshes) {
      // Under cad-out/, not packs/: these are not pack assets until somebody has looked at the
      // dimensions and accepted them.
      expect(mesh.storageKey).toBe(outputKey(orgs.alpha, claim.jobId, mesh.fileName));
      expect(await storage.has(mesh.storageKey!)).toBe(true);
    }
  });

  it('refuses a source file that no longer matches what was submitted', async () => {
    // The bytes are swapped underneath the job. Anything else is a different ingestion wearing this
    // one's row, and its meshes would carry this one's provenance.
    const claim = await queue(STEP);
    await storage.put(claim.sourceKey, Buffer.from(STEP.replace('closure-38', 'something-else')), 'application/octet-stream');

    expect(await runIngestion(claim, deps())).toBe('failed');
    expect((await getIngestion(sql, alpha(), claim.jobId)).error?.code).toBe('corrupt_file');
  });

  it('refuses a file that is not the format its row claims', async () => {
    const claim = await queue('solid part\n facet normal 0 0 1\n endfacet\nendsolid part\n', 'lying.step');

    expect(await runIngestion(claim, deps())).toBe('failed');
    expect((await getIngestion(sql, alpha(), claim.jobId)).error?.code).toBe('unsupported_format');
  });

  it('refuses a file bigger than it will parse, before parsing any of it', async () => {
    const claim = await queue(STEP);

    expect(await runIngestion(claim, deps({ maxSourceBytes: 8 }))).toBe('failed');
    expect((await getIngestion(sql, alpha(), claim.jobId)).error?.code).toBe('too_large');
  });

  it('records a source that has gone missing as the file, not the worker', async () => {
    const claim = await queue(STEP);
    await storage.delete(claim.sourceKey);

    expect(await runIngestion(claim, deps())).toBe('failed');
    expect((await getIngestion(sql, alpha(), claim.jobId)).error?.code).toBe('source_missing');
  });

  it('will not store a result its own validator rejects', async () => {
    // The importer is inside the blast radius; the validator is not. A bounding box with a NaN in
    // it is the cheap version of what a compromised parser would hand back.
    const claim = await queue(STEP);
    const broken = wrap(referenceImporter(), (result) => ({
      ...result,
      bboxMm: [
        [Number.NaN, 0, 0],
        [1, 1, 1],
      ] as const,
    }));

    expect(await runIngestion(claim, deps({ importer: broken }))).toBe('failed');
    const job = await getIngestion(sql, alpha(), claim.jobId);
    expect(job.error?.code).toBe('invalid_result');
    expect(job.result).toBeNull();
  });

  it('will not carry a file the importer did not declare into storage', async () => {
    const claim = await queue(STEP);
    let outputDir = '';
    const sneaky = wrap(
      referenceImporter(),
      (result) => result,
      async (request) => {
        outputDir = request.outputDir;
      },
      async () => {
        await writeFile(join(outputDir, 'extra.glb'), Buffer.from('glTF'));
      },
    );

    expect(await runIngestion(claim, deps({ importer: sneaky }))).toBe('failed');
    const job = await getIngestion(sql, alpha(), claim.jobId);
    expect(job.error?.code).toBe('invalid_result');
    expect(await storage.has(outputKey(orgs.alpha, claim.jobId, 'extra.glb'))).toBe(false);
  });

  it('stops on a cancelled job without storing anything', async () => {
    const claim = await queue(STEP);
    await cancelIngestion(sql, alpha(), claim.jobId);

    expect(await runIngestion(claim, deps())).toBe('abandoned');
    const job = await getIngestion(sql, alpha(), claim.jobId);
    expect(job.status).toBe('canceled');
    expect(job.result).toBeNull();
  });
});

/** A reference importer with something changed about what it does or what it says it did. */
function wrap(
  inner: CadImporter,
  transform: (result: Extract<Awaited<ReturnType<CadImporter['import']>>, { status: 'ok' }>) => unknown,
  before?: (request: CadImportRequest) => Promise<void>,
  after?: () => Promise<void>,
): CadImporter {
  return {
    id: inner.id,
    formats: inner.formats,
    probe: () => inner.probe(),
    async import(request) {
      await before?.(request);
      const result = await inner.import(request);
      await after?.();
      if (result.status !== 'ok') return result;
      return transform(result) as typeof result;
    },
  };
}
