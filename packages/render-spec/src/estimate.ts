import type { RenderSpec } from '@pr/design-schema';

/**
 * Cost and duration estimates shown before a user spends GPU minutes.
 *
 * The constants are a starting calibration for a reference GPU; they are re-fitted from real job
 * telemetry (docs/17-render-service.md) rather than guessed at again. Estimates are advisory in the
 * UI and authoritative only on the server, where quotas are enforced.
 */

export interface CostModel {
  /** Seconds to trace one megapixel at 512 samples on the reference GPU. */
  secondsPerMegapixelAt512: number;
  /** Fixed per-job overhead: asset fetch, scene build, denoise, upload. */
  fixedOverheadSec: number;
  /** Multiplier when true displacement (adaptive subdivision) is enabled. */
  displacementFactor: number;
  /** Additional cost per placement, from extra texture lookups and subdivision. */
  perPlacementFactor: number;
  /** Video frames are cheaper than stills: caches stay warm between frames. */
  videoFrameFactor: number;
  centsPerGpuSecond: number;
}

export const REFERENCE_COST_MODEL: CostModel = {
  secondsPerMegapixelAt512: 22,
  fixedOverheadSec: 12,
  displacementFactor: 1.35,
  perPlacementFactor: 0.06,
  videoFrameFactor: 0.75,
  centsPerGpuSecond: 0.07,
};

export interface RenderEstimate {
  seconds: number;
  cents: number;
  frames: number;
  megapixels: number;
}

export function estimateRender(spec: RenderSpec, model: CostModel = REFERENCE_COST_MODEL): RenderEstimate {
  const sampleScale = spec.quality.samples / 512;
  const displacement =
    spec.quality.displacement.mode === 'displacement' ? model.displacementFactor : 1;
  const placements = 1 + spec.document.placements.length * model.perPlacementFactor;

  let seconds = model.fixedOverheadSec;
  let frames = 0;
  let megapixels = 0;

  for (const output of spec.outputs) {
    const mp = (output.widthPx * output.heightPx) / 1_000_000;
    const perFrame = mp * model.secondsPerMegapixelAt512 * sampleScale * displacement * placements;

    if (output.kind === 'image') {
      frames += 1;
      megapixels += mp;
      seconds += perFrame;
    } else {
      const videoFrames = Math.round(output.fps * output.durationSec);
      frames += videoFrames;
      megapixels += mp * videoFrames;
      seconds += perFrame * videoFrames * model.videoFrameFactor;
    }
  }

  return {
    seconds: Math.round(seconds),
    cents: Math.ceil(seconds * model.centsPerGpuSecond),
    frames,
    megapixels: Number(megapixels.toFixed(3)),
  };
}

/** Human-facing duration copy: users judge a queue by minutes, not seconds. */
export function describeDuration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
