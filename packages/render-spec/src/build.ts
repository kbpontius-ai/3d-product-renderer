import {
  QUALITY_PRESETS,
  RenderSpec,
  type Camera,
  type DesignDocument,
  type RenderQuality,
} from '@pr/design-schema';

export type OutputRequest =
  | {
      kind: 'image';
      widthPx: number;
      heightPx: number;
      format: 'png8' | 'png16' | 'jpeg' | 'webp';
      alpha?: boolean;
      camera: Camera;
    }
  | {
      kind: 'video';
      widthPx: number;
      heightPx: number;
      fps?: 24 | 30 | 60;
      durationSec?: number;
      format?: 'mp4' | 'webm';
    };

export interface BuildRenderSpecInput {
  document: DesignDocument;
  resolved: RenderSpec['resolved'];
  outputs: OutputRequest[];
  preset: RenderQuality['preset'];
  renderer: { id: string; version: string };
  /** Fixed per design version so a re-render reproduces the same noise, not just the same look. */
  seed: number;
  limits?: Partial<RenderSpec['limits']>;
  /** Escape hatch for staff diagnostics; never exposed to end users. */
  qualityOverrides?: Partial<Omit<RenderQuality, 'preset'>>;
}

export const DEFAULT_LIMITS: RenderSpec['limits'] = {
  maxWallClockSec: 1800,
  maxVramMb: 24576,
};

/**
 * Turns a saved design plus resolved asset references into the immutable job input. Everything the
 * worker will ever read is captured here — the worker never looks anything up for itself.
 */
export function buildRenderSpec(input: BuildRenderSpecInput): RenderSpec {
  const quality: RenderQuality = {
    preset: input.preset,
    ...QUALITY_PRESETS[input.preset],
    ...input.qualityOverrides,
  };

  const spec = {
    specVersion: 1 as const,
    document: input.document,
    resolved: {
      ...input.resolved,
      ...(input.document.scene.presentationOrientationOverride &&
      !input.resolved.presentationOrientation
        ? { presentationOrientation: input.document.scene.presentationOrientationOverride }
        : {}),
    },
    outputs: input.outputs.map((o) =>
      o.kind === 'image'
        ? { ...o, alpha: o.alpha ?? false }
        : {
            ...o,
            fps: o.fps ?? 30,
            durationSec: o.durationSec ?? 8,
            format: o.format ?? 'mp4',
            orbit: { elevationDeg: 18, radiusScale: 2.6, startAzimuthDeg: 0, loop: true },
          },
    ),
    quality,
    seed: input.seed,
    renderer: input.renderer,
    limits: { ...DEFAULT_LIMITS, ...input.limits },
  };

  // Parse rather than cast: a malformed spec must fail here, not inside a GPU worker.
  return RenderSpec.parse(spec);
}
