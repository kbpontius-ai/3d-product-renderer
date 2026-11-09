/**
 * Structural similarity between two renders (I1, docs/20).
 *
 * The product's one promise is that the preview and the final render agree, and "agree" has to be a
 * number or it is an opinion. Mean squared error is the obvious number and the wrong one: it is
 * dominated by a slight overall brightness difference, which nobody notices, and blind to a logo
 * being in the wrong place, which everybody does.
 *
 * SSIM compares local structure — mean, variance and covariance over a sliding window — so it
 * measures the thing a person is actually looking at.
 */

export interface Gray {
  width: number;
  height: number;
  /** Luminance, 0..1. */
  data: Float32Array;
}

export interface SsimResult {
  /** Mean over every window. High even when something small is wrong, because most of a frame is
   * background — which is why it is not the only number here. */
  ssim: number;
  /**
   * The mean over the worst windows — by default the worst one per cent of them.
   *
   * The measure that actually catches a misplaced logo. A mark in the wrong position ruins a small
   * number of windows completely and leaves the rest untouched, so the mean barely moves; this
   * looks only at the ruined ones.
   *
   * How small a fraction matters more than it looks. A 14 mm mark on a 38 mm cap covers about half
   * a per cent of the frame, so a fifth-percentile window is still comfortably in the untouched
   * background and reads the same whether the mark moved or not — measured at 0.788 against 0.783
   * for a mark six millimetres out of place. The worst one per cent of the same pair reads 0.572
   * against 0.103. The rank has to be smaller than the feature the measure is about.
   *
   * A trimmed mean rather than a single order statistic: one window is one unlucky pixel block, and
   * the average of a hundred and something is a number that repeats between runs.
   */
  local: number;
  /** The worst window, and where it was — the first place to look when the score drops. */
  worst: { value: number; x: number; y: number };
  /** Mean absolute luminance difference, for telling "darker" apart from "different". */
  meanAbsolute: number;
}

/** Standard SSIM constants for an 8-bit dynamic range, normalised to 0..1 luminance. */
const K1 = 0.01;
const K2 = 0.03;
const C1 = K1 * K1;
const C2 = K2 * K2;

export interface SsimOptions {
  /** Window side in pixels. 8 is the usual choice; larger is smoother and less sensitive. */
  window?: number;
  /** Step between windows. Equal to the window means no overlap and a quicker measurement. */
  step?: number;
  /**
   * The share of worst windows `local` averages over.
   *
   * Smaller than the smallest feature the comparison is about, as a fraction of the frame; see
   * `local` for what happens when it is not.
   */
  localFraction?: number;
}

export function ssim(a: Gray, b: Gray, options: SsimOptions = {}): SsimResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`cannot compare ${a.width}x${a.height} with ${b.width}x${b.height}`);
  }

  const window = options.window ?? 8;
  const step = options.step ?? 4;
  const localFraction = options.localFraction ?? 0.01;

  let total = 0;
  let worst = { value: 1, x: 0, y: 0 };
  let absolute = 0;
  const values: number[] = [];

  for (let i = 0; i < a.data.length; i++) absolute += Math.abs(a.data[i]! - b.data[i]!);

  for (let y = 0; y + window <= a.height; y += step) {
    for (let x = 0; x + window <= a.width; x += step) {
      const value = windowSsim(a, b, x, y, window);
      total += value;
      values.push(value);
      if (value < worst.value) worst = { value, x, y };
    }
  }

  const sorted = [...values].sort((x, y) => x - y);
  const worstCount = Math.max(1, Math.round(sorted.length * localFraction));
  const local = sorted.slice(0, worstCount).reduce((sum, value) => sum + value, 0) / worstCount;

  return {
    ssim: values.length > 0 ? total / values.length : 1,
    local: values.length > 0 ? local : 1,
    worst,
    meanAbsolute: absolute / Math.max(1, a.data.length),
  };
}

function windowSsim(a: Gray, b: Gray, x0: number, y0: number, size: number): number {
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  const n = size * size;

  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const va = a.data[y * a.width + x]!;
      const vb = b.data[y * b.width + x]!;
      sumA += va;
      sumB += vb;
      sumAA += va * va;
      sumBB += vb * vb;
      sumAB += va * vb;
    }
  }

  const meanA = sumA / n;
  const meanB = sumB / n;
  const varA = sumAA / n - meanA * meanA;
  const varB = sumBB / n - meanB * meanB;
  const covariance = sumAB / n - meanA * meanB;

  return (
    ((2 * meanA * meanB + C1) * (2 * covariance + C2)) /
    ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2))
  );
}

/**
 * Luminance from 8-bit RGBA, with alpha composited onto mid grey.
 *
 * Transparent renders exist, and comparing them against an opaque preview would otherwise measure
 * the background rather than the product.
 */
export function toGray(rgba: Uint8Array, width: number, height: number): Gray {
  const data = new Float32Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]! / 255;
    const g = rgba[i * 4 + 1]! / 255;
    const b = rgba[i * 4 + 2]! / 255;
    const alpha = (rgba[i * 4 + 3] ?? 255) / 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = luminance * alpha + 0.5 * (1 - alpha);
  }

  return { width, height, data };
}

/**
 * Nearest-neighbour resize, for comparing images rendered at different resolutions.
 *
 * Deliberately not filtered: a smooth resample hides exactly the high-frequency differences —
 * a bevel that is one pixel wide in one image and two in the other — that this is looking for.
 */
export function resizeGray(source: Gray, width: number, height: number): Gray {
  if (source.width === width && source.height === height) return source;

  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / width));
      data[y * width + x] = source.data[sy * source.width + sx]!;
    }
  }
  return { width, height, data };
}

/**
 * Where the two images differ, as an image.
 *
 * A number tells you a build regressed; this tells you where, which is what anyone looking at a
 * failed parity check actually needs.
 */
export function differenceMap(a: Gray, b: Gray): Gray {
  const data = new Float32Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) data[i] = Math.abs(a.data[i]! - b.data[i]!);
  return { width: a.width, height: a.height, data };
}
