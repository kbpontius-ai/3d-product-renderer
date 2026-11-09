import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareGlb } from '@pr/gltf';
import type { BackendProbe, RenderBackend, RenderRequest, RenderResult } from '@pr/render-backend';
import { buildSceneJob } from './scene.js';
import { probeBlender, runScene } from './run.js';

/**
 * Cycles, in a Blender process on this machine (F-GEN-04).
 *
 * The default implementation of the renderer contract, and — importantly — only an implementation.
 * Everything Blender-specific lives behind here: the generated scene, the process control, the
 * denoiser probe. A deployment that renders somewhere else replaces this object and nothing above
 * it changes.
 */

export interface CyclesLocalOptions {
  /** Absent means whatever `blender` resolves to, or BLENDER_PATH. */
  blenderPath?: string;
}

export function cyclesLocal(options: CyclesLocalOptions = {}): RenderBackend {
  // Probed once and remembered: it costs a process launch, and every render asks the same question.
  let probed: Promise<BackendProbe> | null = null;

  const probe = (): Promise<BackendProbe> =>
    (probed ??= probeBlender(options.blenderPath).then((result) => ({
      available: result.available,
      ...(result.version ? { version: result.version } : {}),
      features: { denoiser: result.denoiser },
      ...(result.available
        ? {}
        : { reason: 'no usable Blender found; set BLENDER_PATH or install it' }),
    })));

  return {
    id: 'cycles-local',
    probe,

    async render(request: RenderRequest): Promise<RenderResult> {
      const capabilities = await probe();
      if (!capabilities.available) {
        return {
          status: 'failed',
          failure: 'internal',
          message: capabilities.reason ?? 'no renderer',
          seconds: 0,
        };
      }

      let job: ReturnType<typeof buildSceneJob>;
      try {
        const mesh = prepareGlb(await readFile(request.meshPath));
        let meshPath = request.meshPath;
        if (mesh.removedEmptyPrimitives) {
          await mkdir(request.scratchDir, { recursive: true });
          meshPath = join(request.scratchDir, 'drawable-mesh.glb');
          await writeFile(meshPath, mesh.bytes);
        }
        job = buildSceneJob({
          spec: request.spec,
          meshPath,
          drawableSlots: mesh.drawableSlots,
          ...(mesh.removedEmptyPrimitives ? { transportBboxMm: mesh.bboxMm } : {}),
          baked: request.baked,
          bakedDir: request.bakedDir,
          outputDir: request.outputDir,
          // A job that asked for denoising on a build without one degrades rather than fails.
          denoiserAvailable: capabilities.features['denoiser'] === true,
          bboxMm: request.bboxMm,
          ...(request.texturePaths ? { texturePaths: request.texturePaths } : {}),
        });
      } catch (reason) {
        return {
          status: 'failed',
          failure: 'asset_missing',
          message: reason instanceof Error ? reason.message : 'Invalid CAD mesh or artwork target.',
          seconds: 0,
        };
      }

      const result = await runScene(job, {
        ...(options.blenderPath ? { blenderPath: options.blenderPath } : {}),
        ...(request.threads ? { threads: request.threads } : {}),
        scratchDir: request.scratchDir,
        timeoutSec: request.timeoutSec,
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        ...(request.shouldCancel ? { shouldCancel: request.shouldCancel } : {}),
      });

      return {
        status: result.status,
        ...(result.failure ? { failure: result.failure } : {}),
        ...(result.message ? { message: result.message } : {}),
        seconds: result.seconds,
        tail: result.tail,
      };
    },
  };
}
