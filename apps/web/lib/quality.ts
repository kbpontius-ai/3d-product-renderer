/**
 * How hard the preview is allowed to work (F-PREV-03).
 *
 * The editor runs a path-traced-looking shader on whatever machine the customer happens to have —
 * a workstation with a discrete GPU, a laptop on integrated graphics, or a virtual machine falling
 * back to software rasterisation. One fixed quality setting is wrong for at least two of those: it
 * either wastes a good GPU or makes a weak one unusable, and a viewport that takes half a second to
 * answer a drag is not a viewport anyone will place artwork in.
 *
 * So the decision is made twice: once up front from what the device says it is, and then
 * continuously from what it actually manages. This module is the deciding, kept apart from the
 * rendering so it can be tested — the alternative is a judgement call buried in a hook that only a
 * person with the wrong laptop can check.
 */

export interface QualityLevel {
  key: 'low' | 'medium' | 'high';
  /** Device-pixel ratio to render at. The single biggest lever: cost goes with its square. */
  dpr: number;
  /** Anisotropic filtering on the artwork and material textures. */
  anisotropy: number;
  /** Multisampling. Off is a visible downgrade, which is why it goes last. */
  antialias: boolean;
  /**
   * Quad budget for the displaced relief surface (`F-PREV-06`).
   *
   * Geometry survives every level, because losing it is losing the feature: an emboss with no
   * silhouette is the shading trick this replaced. What varies is how fine the relief can be
   * before the fragment shader has to make up the difference, which it does automatically.
   */
  patchQuads: number;
  /**
   * Height-field ambient occlusion (`F-PREV-07`).
   *
   * Twenty-four texture taps per fragment, and the only thing here that costs fill rate rather
   * than vertex rate — so it is what goes first on a device that cannot hold the frame budget.
   */
  zoneAo: boolean;
}

/**
 * Three levels, not a continuum.
 *
 * A continuously varying resolution hunts: it drops, the frame gets cheap, it rises, the frame gets
 * expensive, and the customer watches the viewport shimmer. Three steps with hysteresis between
 * them settle.
 */
export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { key: 'low', dpr: 0.75, anisotropy: 1, antialias: false, patchQuads: 24_000, zoneAo: false },
  { key: 'medium', dpr: 1, anisotropy: 4, antialias: true, patchQuads: 90_000, zoneAo: true },
  { key: 'high', dpr: 2, anisotropy: 8, antialias: true, patchQuads: 260_000, zoneAo: true },
];

export interface DeviceHints {
  /** WebGL is being emulated on the CPU — SwiftShader, llvmpipe, a VM with no passthrough. */
  softwareRenderer: boolean;
  /** The largest texture the driver will accept. A low ceiling means a low-end or old device. */
  maxTextureSize: number;
  devicePixelRatio: number;
}

/**
 * Where to start, before anything has been measured.
 *
 * Starting high and falling back means the first thing a customer on a weak machine sees is the
 * viewport stuttering; starting from what the device admits about itself means most of them never
 * see a downgrade at all. Measurement still gets the last word — this is only the opening guess.
 */
export function startingLevel(hints: DeviceHints): number {
  // Software rasterisation is not a slow GPU, it is no GPU: every pixel costs a CPU cycle, and the
  // difference between levels is the difference between usable and not.
  if (hints.softwareRenderer) return 0;
  if (hints.maxTextureSize < 8192) return 1;
  // A device that reports no scaling is usually an older or lower-powered screen; there is nothing
  // to gain from rendering above it either way.
  return hints.devicePixelRatio >= 1.5 ? 2 : 1;
}

/** Frame times either side of which the level moves, in milliseconds. */
export const FRAME_BUDGET_MS = 1000 / 45;
const COMFORTABLE_MS = 1000 / 58;

/**
 * The smallest sample worth acting on.
 *
 * The first frames after a mesh loads or a texture uploads are always slow, and dropping quality
 * because of them would punish every product for being loaded at all.
 */
export const MIN_SAMPLES = 12;

/**
 * The next quality level, given how the recent frames actually went.
 *
 * Median rather than mean: one 200 ms frame while a texture uploads is not what the viewport feels
 * like, and an average lets that single frame decide.
 *
 * The two thresholds are deliberately far apart. If "too slow" and "fast enough to go up" were the
 * same number, a machine sitting near it would step up and down forever, and that oscillation is
 * more distracting than either level.
 */
export function nextLevel(current: number, frameMs: readonly number[]): number {
  if (frameMs.length < MIN_SAMPLES) return current;

  const median = [...frameMs].sort((a, b) => a - b)[Math.floor(frameMs.length / 2)]!;
  if (median > FRAME_BUDGET_MS) return Math.max(0, current - 1);
  if (median < COMFORTABLE_MS) return Math.min(QUALITY_LEVELS.length - 1, current + 1);
  return current;
}

/**
 * What the driver says it is.
 *
 * `WEBGL_debug_renderer_info` is the only way to tell a real GPU from a software fallback, and
 * browsers may refuse it for fingerprinting reasons — in which case the answer is "assume hardware"
 * and let the measurement sort it out.
 */
export function readDeviceHints(gl: WebGLRenderingContext | WebGL2RenderingContext): DeviceHints {
  let renderer = '';
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
  } catch {
    renderer = '';
  }

  return {
    softwareRenderer: /swiftshader|llvmpipe|software|microsoft basic/i.test(renderer),
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0),
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  };
}

/**
 * Reads the device hints before there is a scene to read them from.
 *
 * Antialiasing is fixed when the WebGL context is created and cannot be turned off later without
 * throwing the context away, so the opening level has to be known before the canvas exists. A
 * throwaway context is the only way to ask, and it costs a few milliseconds once.
 */
export function probeDeviceHints(): DeviceHints {
  const fallback: DeviceHints = { softwareRenderer: false, maxTextureSize: 8192, devicePixelRatio: 1 };
  if (typeof document === 'undefined') return fallback; // Server render: nothing to ask.

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return fallback;

  const hints = readDeviceHints(gl as WebGLRenderingContext);
  // Hand the context back rather than waiting for the browser to reclaim it: there is a hard limit
  // on how many a page may hold, and the materials admin page has already run into it once.
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return hints;
}
