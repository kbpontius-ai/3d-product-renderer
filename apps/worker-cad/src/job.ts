import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_BUDGETS,
  DEFAULT_LIMITS,
  budgetsForSize,
  sniffFormat,
  validateImportResult,
  type CadFailureCode,
  type CadImporter,
  type CadImportResult,
  type CadIssue,
  type CadMeshFile,
  type CadStage,
} from '@pr/cad';
import { completeIngestion, failIngestion, heartbeatIngestion, type CadClaim } from '@pr/cad-jobs';
import type { Sql } from '@pr/db';
import { contentTypeFor, ObjectNotFound, type Storage } from '@pr/storage';
import { increment, observe, type Logger } from '@pr/observability';

/**
 * Running one ingestion (docs/23-cad-ingestion.md, "Stages").
 *
 * The same shape as the render supervisor, for the same reasons: fetch what the job names, verify
 * it is what the job was submitted against, hand it to something that does the actual work, report
 * through the heartbeat — which doubles as the check for whether this job is still ours — and only
 * then write anything down.
 *
 * One thing it does that the render supervisor does not: it disbelieves its own worker. The
 * importer has just finished reading a stranger's file inside a large native parser, and everything
 * it hands back goes through `validateImportResult` before a byte of it is stored.
 */

export interface IngestionDeps {
  sql: Sql;
  storage: Storage;
  workerId: string;
  scratchRoot: string;
  /** Whatever actually reads CAD. The supervisor knows the contract, not the kernel. */
  importer: CadImporter;
  /** Cores the importer may use; absent means every one of them. */
  threads?: number;
  /** Refuse a source file larger than this before a parser ever sees it. */
  maxSourceBytes: number;
  timeoutSec: number;
  onProgress?: (stage: CadStage, fraction: number) => void;
  log: Logger;
}

export type IngestionOutcome = 'succeeded' | 'failed' | 'requeued' | 'abandoned';

/** Where an ingestion's meshes land before there is a pack to put them in. */
export const outputKey = (orgId: string, jobId: string, fileName: string): string =>
  `cad-out/${orgId}/${jobId}/${fileName}`;

export async function runIngestion(claim: CadClaim, deps: IngestionDeps): Promise<IngestionOutcome> {
  const scratch = join(deps.scratchRoot, claim.jobId);
  const stages: Record<string, number> = {};
  let stageStarted = Date.now();
  let stageName: string | null = null;

  const report = async (stage: string, fraction: number): Promise<boolean> => {
    if (stageName && stage !== stageName) {
      const ms = Date.now() - stageStarted;
      stages[stageName] = (stages[stageName] ?? 0) + ms;
      observe(`cad.stage.${stageName}`, ms);
    }
    if (stage !== stageName) {
      stageName = stage;
      stageStarted = Date.now();
    }
    deps.onProgress?.(stage as CadStage, fraction);
    return heartbeatIngestion(deps.sql, claim.jobId, deps.workerId, { stage, progress: fraction });
  };

  const closeStage = () => {
    if (!stageName) return;
    const ms = Date.now() - stageStarted;
    stages[stageName] = (stages[stageName] ?? 0) + ms;
    observe(`cad.stage.${stageName}`, ms);
    stageName = null;
  };

  try {
    await mkdir(join(scratch, 'out'), { recursive: true });
    await mkdir(join(scratch, 'work'), { recursive: true });

    if (!(await report('fetch', 0.02))) return 'abandoned';

    // A cap before a parser, not after. A 4 GB assembly is not a thing to be brave about, and the
    // point of a limit is that it is hit before the memory is allocated.
    if (claim.sourceBytes > deps.maxSourceBytes) {
      return await giveUp(claim, deps, stages, closeStage, {
        code: 'too_large',
        message: `the file is ${claim.sourceBytes} bytes, over the ${deps.maxSourceBytes} this worker will parse`,
      });
    }

    const source = await deps.storage.get(claim.sourceKey);

    // The file must be the file the job was submitted against. Anything else is a different
    // ingestion wearing this one's row — and its meshes would carry this one's provenance.
    const digest = createHash('sha256').update(source.bytes).digest();
    if (!digest.equals(claim.sourceDigest)) {
      return await giveUp(claim, deps, stages, closeStage, {
        code: 'corrupt_file',
        message: 'the stored source file no longer matches the digest it was submitted with',
      });
    }

    // Sniffed again here, before the kernel, because the format decides which grammar a native
    // parser is pointed at and the row was written by something else, a while ago.
    const sniffed = sniffFormat(source.bytes, claim.sourceName ?? undefined);
    if (sniffed.format !== claim.format) {
      return await giveUp(claim, deps, stages, closeStage, {
        code: 'unsupported_format',
        message: `the file is ${sniffed.format ?? 'not a CAD format we recognise'}, not ${claim.format}`,
      });
    }

    const sourcePath = join(scratch, 'source');
    await writeFile(sourcePath, source.bytes);

    if (!(await report('parse', 0.05))) return 'abandoned';

    let alive = true;
    const result = await deps.importer.import({
      sourcePath,
      format: claim.format,
      // STEP declares its unit; STL never does. Stating the assumption is what lets the result say
      // whether it was used, which is what stops a pack being wrong by 25.4× in every render.
      assumeUnit: 'mm',
      lods: DEFAULT_BUDGETS.map((budget) => ({ ...budget })),
      outputDir: join(scratch, 'out'),
      scratchDir: join(scratch, 'work'),
      timeoutSec: deps.timeoutSec,
      limits: DEFAULT_LIMITS,
      ...(deps.threads ? { threads: deps.threads } : {}),
      onProgress: (stage, fraction) => {
        // Tessellation is the long stage, so it owns most of the progress bar.
        void report(stage, 0.05 + fraction * 0.75).then((ok) => {
          alive = ok;
        });
      },
      shouldCancel: async () => !(await heartbeatIngestion(deps.sql, claim.jobId, deps.workerId)),
    });

    if (!alive || (result.status === 'failed' && result.failure === 'canceled')) return 'abandoned';

    if (result.status === 'failed') {
      return await giveUp(claim, deps, stages, closeStage, {
        code: result.failure,
        message: result.message,
      });
    }

    if (!(await report('validate', 0.85))) return 'abandoned';

    // The importer is inside the blast radius. This is not.
    const issues = await validateImportResult(result, {
      budgets: budgetsForSize(longestEdge(result)),
      readMesh: (fileName) => readFile(join(scratch, 'out', fileName)),
    });
    if (issues.length > 0) {
      deps.log.error('the importer produced a result we will not store', undefined, {
        issues: issues.map((issue) => `${issue.code}${issue.subject ? ` (${issue.subject})` : ''}`),
      });
      return await giveUp(claim, deps, stages, closeStage, {
        code: 'invalid_result',
        message:
          issues.length === 1
            ? 'The import finished, but one thing about the result stops it becoming a pack.'
            : `The import finished, but ${issues.length} things about the result stop it becoming a pack.`,
        // All of them, not the first. Each one an operator is not shown is a re-export, another
        // import, and another wait to discover the next.
        findings: issues,
      });
    }

    // Nothing but the meshes the result declares. A file in the output directory that no mesh
    // names is something the supervisor did not ask for and will not carry into storage.
    const written = await readdir(join(scratch, 'out'));
    const declared = new Set(result.meshes.map((mesh) => mesh.fileName));
    const stray = written.filter((name) => !declared.has(name));
    if (stray.length > 0) {
      return await giveUp(claim, deps, stages, closeStage, {
        code: 'invalid_result',
        message: `the importer wrote ${stray.length} file(s) it did not declare`,
      });
    }

    if (!(await report('upload', 0.92))) return 'abandoned';
    const meshes = await uploadMeshes(claim, result.meshes, deps.storage, join(scratch, 'out'));

    closeStage();
    const stored = await completeIngestion(deps.sql, claim.jobId, deps.workerId, {
      result: { ...result, meshes },
      cpuSeconds: result.seconds,
    });

    if (stored) {
      increment('cad.succeeded');
      deps.log.info('ingestion finished', {
        seconds: Number(result.seconds.toFixed(2)),
        parts: result.parts.length,
        repairs: result.repairs.length,
        triangles: meshes.reduce((sum, mesh) => sum + mesh.triangles, 0),
        stages,
      });
    }
    return stored ? 'succeeded' : 'abandoned';
  } catch (error) {
    closeStage();
    deps.log.error('ingestion threw', error, { stages });
    const outcome = await failIngestion(deps.sql, claim.jobId, deps.workerId, {
      code: error instanceof ObjectNotFound ? 'source_missing' : 'internal',
      message: error instanceof Error ? error.message : 'unknown failure',
    });
    increment(outcome === 'requeued' ? 'cad.requeued' : 'cad.failed');
    return outcome === 'requeued' ? 'requeued' : 'failed';
  } finally {
    // The scratch directory held a stranger's CAD file. It does not outlive the job.
    await rm(scratch, { recursive: true, force: true });
  }
}

async function giveUp(
  claim: CadClaim,
  deps: IngestionDeps,
  stages: Record<string, number>,
  closeStage: () => void,
  failure: { code: CadFailureCode; message: string; findings?: CadIssue[] },
): Promise<IngestionOutcome> {
  closeStage();
  deps.log.warn('ingestion refused', { failure: failure.code, detail: failure.message, stages });
  const outcome = await failIngestion(deps.sql, claim.jobId, deps.workerId, failure);
  increment(outcome === 'requeued' ? 'cad.requeued' : 'cad.failed');
  return outcome === 'requeued' ? 'requeued' : 'failed';
}

/**
 * Puts the meshes where the pack drafting step will look for them.
 *
 * Under `cad-out/`, not `packs/`: these are not pack assets until somebody has looked at the
 * dimensions and accepted them, and a prefix the catalog serves is not the place to stage something
 * nobody has approved.
 */
async function uploadMeshes(
  claim: CadClaim,
  meshes: readonly CadMeshFile[],
  storage: Storage,
  outDir: string,
): Promise<CadMeshFile[]> {
  const stored: CadMeshFile[] = [];

  for (const mesh of meshes) {
    const key = outputKey(claim.orgId, claim.jobId, mesh.fileName);
    await storage.put(key, await readFile(join(outDir, mesh.fileName)), contentTypeFor(key));
    stored.push({ ...mesh, storageKey: key });
  }

  return stored;
}

const longestEdge = (result: CadImportResult): number => {
  const [min, max] = result.bboxMm;
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
};
