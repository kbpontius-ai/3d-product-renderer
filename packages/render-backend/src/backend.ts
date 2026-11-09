import type { RenderSpec } from '@pr/design-schema';

/**
 * The renderer contract (F-GEN-04).
 *
 * Cycles is the implementation this ships with, not the definition of what rendering is. A
 * deployment with its own farm, a commercial engine it must match, or a serverless GPU service
 * should be able to satisfy this interface and change nothing else — which is only true if the
 * worker never reaches past it.
 *
 * The boundary is files and a spec, not objects: everything crossing it is either JSON or a path on
 * disk, so a backend may run in this process, in another one, or on another machine.
 */

export interface BakedMapRef {
  placementId: string;
  kind: 'height' | 'ink';
  /** File name inside `bakedDir`. */
  fileName: string;
  width: number;
  height: number;
  /** For height maps: what 0 and 65535 mean, in millimetres. */
  rangeMm?: readonly [number, number];
}

export interface RenderRequest {
  /** What to render. Already validated; a backend may trust its shape but not its provenance. */
  spec: RenderSpec;
  /** Local path to the mesh, fetched and digest-checked by the supervisor. */
  meshPath: string;
  /** Directory holding the baked maps named below. */
  bakedDir: string;
  baked: BakedMapRef[];
  /**
   * Material textures, by the storage key the spec names, already fetched to local paths.
   *
   * The supervisor fetches; a backend reads files. Handing over paths rather than keys is what
   * keeps a backend from needing storage credentials of its own.
   */
  texturePaths?: Record<string, string>;
  /** Where the images must be written. One file per requested output, sorted by name. */
  outputDir: string;
  /** Scratch space the backend may use and the supervisor will delete. */
  scratchDir: string;
  bboxMm: RenderSpec['resolved']['bboxMm'];
  timeoutSec: number;
  /** Cores the renderer may use. Absent means all of them. */
  threads?: number;
  onProgress?: (stage: string, fraction: number) => void;
  /** Polled while rendering; returning true means stop, because the job is no longer ours. */
  shouldCancel?: () => Promise<boolean> | boolean;
}

/** Why a render did not produce images. Exactly the queue's failure vocabulary, so the
 * supervisor can record what it is told without translating and losing the distinction. */
export type RenderFailure =
  | 'renderer_crash'
  | 'renderer_unavailable'
  | 'timeout'
  | 'canceled'
  | 'oom'
  | 'asset_missing'
  | 'internal';

export interface RenderResult {
  status: 'ok' | 'failed';
  failure?: RenderFailure;
  message?: string;
  /** Wall-clock seconds the render took, for cost accounting and provenance. */
  seconds: number;
  /** Last lines of whatever the renderer said, kept for the job's error record. */
  tail?: string[];
}

export interface BackendProbe {
  available: boolean;
  version?: string;
  /**
   * What this build can do, by name.
   *
   * The supervisor asks rather than assumes: Blender builds without OpenImageDenoise exist, and a
   * job that requested denoising should degrade rather than fail.
   */
  features: Record<string, boolean>;
  /** Why it is unavailable, when it is. */
  reason?: string;
}

export interface RenderBackend {
  /** Recorded in every job's provenance, so a render can be attributed to what produced it. */
  readonly id: string;
  probe(): Promise<BackendProbe>;
  render(request: RenderRequest): Promise<RenderResult>;
}
