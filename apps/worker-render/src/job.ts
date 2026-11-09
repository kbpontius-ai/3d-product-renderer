import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, downscaleRgba, encodeRgbaPng } from '@pr/artwork/png';
import { RenderSpec } from '@pr/design-schema';
import { bakeSpec, type ArtworkSource } from '@pr/blender';
import type { RenderBackend } from '@pr/render-backend';
import type { Sql } from '@pr/db';
import {
  completeJob,
  failJob,
  heartbeat,
  type FailureCode,
  type JobClaim,
  type RenderOutput,
} from '@pr/render-jobs';
import { contentTypeFor, ObjectNotFound, type Storage } from '@pr/storage';
import { increment, observe, type Logger } from '@pr/observability';
import { notifyRenderFinished, type Mailer } from '@pr/notifications';

/**
 * Running one job (docs/17 §"Supervisor loop").
 *
 * The shape of it: parse the spec (trust nothing, even from our own API), fetch what it names, bake
 * the artwork, generate the scene, run Blender, upload the results. Every stage reports through the
 * heartbeat, which doubles as the check for whether this job is still ours — a cancelled or
 * reclaimed job stops here rather than racing another worker to write the same outputs.
 */

export interface JobDeps {
  sql: Sql;
  storage: Storage;
  workerId: string;
  scratchRoot: string;
  /** Whatever actually renders. The supervisor knows the contract, not the renderer. */
  backend: RenderBackend;
  /** Rendering threads; absent means every core. */
  threads?: number;
  onProgress?: (stage: string, fraction: number) => void;
  log: Logger;
  /** Where render-finished mail goes. Absent means the log, which is honest about not sending. */
  mailer?: Mailer;
  appUrl?: string;
}

export type JobOutcome = 'succeeded' | 'failed' | 'requeued' | 'abandoned';

export async function runJob(claim: JobClaim, deps: JobDeps): Promise<JobOutcome> {
  const scratch = join(deps.scratchRoot, claim.jobId);

  /**
   * How long each stage took, recorded as the job passes through them.
   *
   * Process metrics vanish on restart, and "which stage is slow" is usually asked about one job
   * that was slow last week — so this rides along in the job's provenance, where the admin queue
   * view can read it back.
   */
  const stages: Record<string, number> = {};
  let stageStarted = Date.now();
  let stageName: string | null = null;

  const report = async (stage: string, fraction: number): Promise<boolean> => {
    if (stageName && stage !== stageName) {
      const ms = Date.now() - stageStarted;
      stages[stageName] = (stages[stageName] ?? 0) + ms;
      observe(`render.stage.${stageName}`, ms);
    }
    if (stage !== stageName) {
      stageName = stage;
      stageStarted = Date.now();
    }
    deps.onProgress?.(stage, fraction);
    return heartbeat(deps.sql, claim.jobId, deps.workerId, { stage, progress: fraction });
  };

  const closeStage = () => {
    if (!stageName) return;
    const ms = Date.now() - stageStarted;
    stages[stageName] = (stages[stageName] ?? 0) + ms;
    observe(`render.stage.${stageName}`, ms);
    stageName = null;
  };

  try {
    const parsed = RenderSpec.safeParse(claim.spec);
    if (!parsed.success) {
      deps.log.error('render spec rejected by its own schema', undefined, {
        issues: parsed.error.issues.length,
      });
      await failJob(deps.sql, claim.jobId, deps.workerId, {
        code: 'internal',
        message: 'the stored render spec does not match the schema',
      });
      increment('render.failed');
      return 'failed';
    }
    const spec = parsed.data;

    await mkdir(join(scratch, 'assets'), { recursive: true });
    await mkdir(join(scratch, 'baked'), { recursive: true });
    await mkdir(join(scratch, 'out'), { recursive: true });

    if (!(await report('assets', 0.05))) return 'abandoned';
    const assets = await fetchAssets(spec, deps.storage, scratch);

    if (!(await report('bake', 0.15))) return 'abandoned';
    const baked = bakeSpec(spec, assets.artwork);
    for (const map of baked) await writeFile(join(scratch, 'baked', map.fileName), map.png);

    if (!(await report('build', 0.2))) return 'abandoned';

    let alive = true;
    const result = await deps.backend.render({
      spec,
      meshPath: assets.meshPath,
      baked,
      bakedDir: join(scratch, 'baked'),
      outputDir: join(scratch, 'out'),
      scratchDir: join(scratch, 'work'),
      texturePaths: assets.texturePaths,
      bboxMm: assets.bboxMm,
      timeoutSec: spec.limits.maxWallClockSec,
      ...(deps.threads ? { threads: deps.threads } : {}),
      onProgress: (stage, fraction) => {
        // Tracing is the long stage, so it owns most of the progress bar.
        void report(stage, stage === 'trace' ? 0.2 + fraction * 0.7 : 0.2).then((ok) => {
          alive = ok;
        });
      },
      shouldCancel: async () => !(await heartbeat(deps.sql, claim.jobId, deps.workerId)),
    });

    if (!alive || result.failure === 'canceled') return 'abandoned';

    if (result.status !== 'ok') {
      closeStage();
      deps.log.error('renderer failed', undefined, {
        failure: result.failure ?? 'renderer_crash',
        detail: result.message,
        stages,
        tail: result.tail,
      });
      const outcome = await failJob(deps.sql, claim.jobId, deps.workerId, {
        code: (result.failure ?? 'renderer_crash') as FailureCode,
        message: result.message ?? 'the renderer failed',
      });
      increment(outcome === 'requeued' ? 'render.requeued' : 'render.failed');
      // Only the final failure is worth telling anyone about: a requeue is the system retrying,
      // which is not news to the person waiting.
      if (outcome !== 'requeued') {
        await tell(claim, deps, 'failed', result.seconds, {
          code: result.failure ?? 'renderer_crash',
          message: result.message ?? 'the renderer failed',
        });
      }
      return outcome === 'requeued' ? 'requeued' : 'failed';
    }

    if (!(await report('upload', 0.95))) return 'abandoned';
    const outputs = await uploadOutputs(claim, spec, deps.storage, join(scratch, 'out'), deps.log);

    closeStage();
    const stored = await completeJob(deps.sql, claim.jobId, deps.workerId, {
      outputs,
      gpuSeconds: result.seconds,
      provenance: {
        renderer: `${spec.renderer.id} ${spec.renderer.version}`,
        backend: deps.backend.id,
        samples: spec.quality.samples,
        denoiser: spec.quality.denoiser,
        seed: spec.seed,
        worker: deps.workerId,
        seconds: Number(result.seconds.toFixed(2)),
        stages,
      },
    });

    if (stored) {
      increment('render.succeeded');
      deps.log.info('render finished', { seconds: Number(result.seconds.toFixed(2)), stages, outputs: outputs.length });
      await tell(claim, deps, 'succeeded', result.seconds);
    }
    return stored ? 'succeeded' : 'abandoned';
  } catch (error) {
    closeStage();
    deps.log.error('job threw', error, { stages });
    const outcome = await failJob(deps.sql, claim.jobId, deps.workerId, {
      code: error instanceof ObjectNotFound ? 'asset_missing' : 'internal',
      message: error instanceof Error ? error.message : 'unknown failure',
    });
    increment(outcome === 'requeued' ? 'render.requeued' : 'render.failed');
    if (outcome !== 'requeued') {
      await tell(claim, deps, 'failed', 0, {
        code: error instanceof ObjectNotFound ? 'asset_missing' : 'internal',
        message: error instanceof Error ? error.message : 'unknown failure',
      });
    }
    return outcome === 'requeued' ? 'requeued' : 'failed';
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Tells whoever asked for the render how it went.
 *
 * Never allowed to change the outcome: the job is already stored, and a notification that failed to
 * send is a smaller problem than a finished render marked failed because the mailer was down.
 */
async function tell(
  claim: JobClaim,
  deps: JobDeps,
  status: 'succeeded' | 'failed',
  seconds: number,
  failure?: { code: string; message: string },
): Promise<void> {
  try {
    await notifyRenderFinished(
      deps.sql,
      {
        jobId: claim.jobId,
        orgId: claim.orgId,
        designId: claim.designId,
        userId: claim.submittedBy,
        status,
        seconds,
        failure,
      },
      { ...(deps.mailer ? { mailer: deps.mailer } : {}), ...(deps.appUrl ? { appUrl: deps.appUrl } : {}) },
    );
  } catch (error) {
    deps.log.warn('could not record the render notification', { error: String(error) });
  }
}

// -----------------------------------------------------------------------------------------------

interface FetchedAssets {
  meshPath: string;
  bboxMm: RenderSpec['resolved']['bboxMm'];
  artwork: Map<string, ArtworkSource>;
  /** Material textures, by the storage key the material names (F-MAT-04). */
  texturePaths: Record<string, string>;
}

/**
 * Downloads what the spec names, and nothing else.
 *
 * Digests are verified where the spec carries one: an asset that does not match what the job was
 * submitted against is a different render, and rendering it anyway would put the wrong product in
 * front of a customer.
 */
async function fetchAssets(spec: RenderSpec, storage: Storage, scratch: string): Promise<FetchedAssets> {
  const mesh = await storage.get(spec.resolved.meshKey);
  verifyDigest(spec.resolved.meshKey, mesh.bytes, spec.resolved.meshDigest);

  const meshPath = join(scratch, 'assets', 'mesh.glb');
  await writeFile(meshPath, mesh.bytes);

  const artwork = new Map<string, ArtworkSource>();
  for (const entry of spec.resolved.artwork) {
    const sdf = await storage.get(entry.sdfKey);
    const mask = await storage.get(entry.maskKey);
    artwork.set(entry.versionId, {
      sdfPng: sdf.bytes,
      sdfRangeMm: entry.sdfRangeMm,
      maskPng: mask.bytes,
    });
  }

  return { meshPath, bboxMm: spec.resolved.bboxMm, artwork, texturePaths: await fetchTextures(spec, storage, scratch) };
}

/**
 * Texture sets for the materials this design uses.
 *
 * A missing texture is not a failed render: the material still has its numbers, and a slightly
 * plain product beats no image at all. It is logged rather than thrown, because the pack is what
 * needs fixing and the customer's design is not at fault.
 */
async function fetchTextures(
  spec: RenderSpec,
  storage: Storage,
  scratch: string,
): Promise<Record<string, string>> {
  const wanted = new Set<string>();
  for (const material of spec.resolved.materials) {
    for (const [slot, reference] of Object.entries(material.definition.maps)) {
      if (slot === 'tilingMm' || !reference || typeof reference !== 'object') continue;
      wanted.add((reference as { path: string }).path);
    }
  }
  if (wanted.size === 0) return {};

  const dir = join(scratch, 'textures');
  await mkdir(dir, { recursive: true });

  const paths: Record<string, string> = {};
  for (const key of wanted) {
    try {
      const file = await storage.get(key);
      const path = join(dir, key.replace(/[^a-zA-Z0-9._-]/g, '_'));
      await writeFile(path, file.bytes);
      paths[key] = path;
    } catch {
      // Left out of the map; the scene builder then renders that material from its numbers.
    }
  }
  return paths;
}

async function uploadOutputs(
  claim: JobClaim,
  spec: RenderSpec,
  storage: Storage,
  dir: string,
  log: Logger,
): Promise<RenderOutput[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.png')).sort();
  const outputs: RenderOutput[] = [];

  for (const [index, name] of files.entries()) {
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    const key = `renders/${claim.orgId}/${claim.jobId}/${name}`;
    await storage.put(key, bytes, contentTypeFor(key));

    const web = await webVariant(bytes, log);
    const webKey = web ? `renders/${claim.orgId}/${claim.jobId}/${name.replace(/\.png$/, '')}.web.png` : null;
    if (web && webKey) await storage.put(webKey, web, contentTypeFor(webKey));

    const requested = spec.outputs[index];
    outputs.push({
      kind: 'image',
      storageKey: key,
      ...(requested?.kind === 'image'
        ? { width: requested.widthPx, height: requested.heightPx, format: requested.format }
        : {}),
      bytes: bytes.byteLength,
      ...(web && webKey ? { webStorageKey: webKey, webBytes: web.byteLength } : {}),
    });
  }

  if (outputs.length === 0) throw new Error('the renderer produced no images');
  return outputs;
}

/** The longest side of a web-sized copy. Enough to fill a gallery tile on a dense display. */
const WEB_VARIANT_PX = 1024;

/**
 * A small copy of a finished render, for looking at (F-EXP-01).
 *
 * The original is what gets downloaded and sent to a printer — 2K or 4K, sixteen bits a channel,
 * tens of megabytes — and the gallery was putting that file in an `img` tag. This is eight-bit and
 * a megapixel at most, which is what a browser actually needs to show it.
 *
 * Best effort on purpose: a render that succeeded must not be reported as failed because a
 * convenience copy could not be made, so anything unreadable here just means there is no small
 * copy and the reader falls back to the original.
 */
async function webVariant(png: Uint8Array, log: Logger): Promise<Uint8Array | null> {
  try {
    const decoded = decodePng(png);
    if (decoded.width <= WEB_VARIANT_PX && decoded.height <= WEB_VARIANT_PX && decoded.bitDepth === 8) {
      return null; // Already small and already eight-bit: a second copy would buy nothing.
    }

    const rgba = toRgba(decoded);
    const small = downscaleRgba(rgba, decoded.width, decoded.height, WEB_VARIANT_PX);
    return encodeRgbaPng(small.rgba, small.width, small.height);
  } catch (error) {
    log.warn('could not make a web-sized copy', { error: String(error) });
    return null;
  }
}

/** Whatever the renderer wrote — grey or colour, eight or sixteen bit — as eight-bit RGBA. */
function toRgba(decoded: ReturnType<typeof decodePng>): Uint8Array {
  const { width, height, channels, data } = decoded;
  const max = decoded.bitDepth === 16 ? 65535 : 255;
  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const sample = (channel: number) =>
      Math.round((Number(data[i * channels + channel] ?? max) / max) * 255);

    const r = sample(0);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = channels >= 3 ? sample(1) : r;
    rgba[i * 4 + 2] = channels >= 3 ? sample(2) : r;
    rgba[i * 4 + 3] = channels === 2 ? sample(1) : channels === 4 ? sample(3) : 255;
  }

  return rgba;
}

function verifyDigest(key: string, bytes: Uint8Array, expected: string): void {
  // All-zero is the schema's stand-in for "not recorded yet"; a real digest is always checked.
  if (/^0+$/.test(expected)) return;

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`${key} does not match the digest this job was submitted against`);
  }
}
