/**
 * Signed distance field generation.
 *
 * The SDF is the artwork representation everything downstream depends on: the preview shader and
 * the render worker both evaluate the height profile as a function of distance-to-edge, which is
 * why depth, bevel, and edge radius are free parameters that never require re-processing the SVG.
 *
 * Convention: positive INSIDE the artwork, in millimetres.
 *
 * Accuracy: pixels on the antialiased edge are sub-pixel accurate (from coverage); interior and
 * exterior distances are accurate to about one pixel, because the transform measures to the nearest
 * sample rather than to the true boundary. At the pipeline's working resolution (~80 px/mm) that is
 * ~0.012 mm — far below any relief depth we support — and preview and render consume the SAME field,
 * so the two never disagree.
 */

export interface Gray {
  /** Coverage, 0 = background, 255 = fully covered. Antialiased edges carry intermediate values. */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface SignedDistanceField {
  data: Float32Array;
  width: number;
  height: number;
  mmPerPx: number;
  minMm: number;
  maxMm: number;
}

const INF = 1e20;

/**
 * Felzenszwalb & Huttenlocher exact squared distance transform, 1D pass.
 * `f` holds the sampled function; results are written to `d`. O(n).
 */
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dx = q - v[k]!;
    d[q] = dx * dx + f[v[k]!]!;
  }
}

/** Squared Euclidean distance from every pixel to the nearest pixel where `isFeature` is true. */
export function squaredDistanceTransform(
  width: number,
  height: number,
  isFeature: (index: number) => boolean,
): Float64Array {
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = isFeature(i) ? 0 : INF;

  const maxDim = Math.max(width, height);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]!;
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]!;
  }

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = grid[row + x]!;
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[row + x] = d[x]!;
  }

  return grid;
}

const EDGE_LOW = 8;
const EDGE_HIGH = 247;

/**
 * Builds a signed distance field from an antialiased coverage mask.
 *
 * Pixels on the antialiased edge use their coverage to place the boundary sub-pixel; everything
 * else uses the exact distance transform. Without the sub-pixel term, small artwork would emboss
 * with visibly stair-stepped walls.
 */
export function signedDistanceFieldMm(mask: Gray, mmPerPx: number): SignedDistanceField {
  const { data, width, height } = mask;
  const inside = (i: number) => data[i]! >= 128;

  const distToBackground = squaredDistanceTransform(width, height, (i) => !inside(i));
  const distToForeground = squaredDistanceTransform(width, height, inside);

  const out = new Float32Array(width * height);
  let minMm = Infinity;
  let maxMm = -Infinity;

  for (let i = 0; i < out.length; i++) {
    const coverage = data[i]!;
    let px: number;

    if (coverage > EDGE_LOW && coverage < EDGE_HIGH) {
      // Partially covered: the edge runs through this pixel.
      px = coverage / 255 - 0.5;
    } else if (inside(i)) {
      px = Math.sqrt(distToBackground[i]!) - 0.5;
    } else {
      px = -(Math.sqrt(distToForeground[i]!) - 0.5);
    }

    const mm = px * mmPerPx;
    out[i] = mm;
    if (mm < minMm) minMm = mm;
    if (mm > maxMm) maxMm = mm;
  }

  return { data: out, width, height, mmPerPx, minMm, maxMm };
}

/** Encodes millimetres to 16-bit for PNG storage. The range travels with the asset. */
export function encode16(value: number, range: readonly [number, number]): number {
  const [lo, hi] = range;
  const t = (value - lo) / (hi - lo);
  return Math.max(0, Math.min(65535, Math.round(t * 65535)));
}

export function decode16(encoded: number, range: readonly [number, number]): number {
  const [lo, hi] = range;
  return lo + (encoded / 65535) * (hi - lo);
}

export function encodeFieldTo16(
  field: SignedDistanceField,
  range: readonly [number, number] = [field.minMm, field.maxMm],
): { data: Uint16Array; range: readonly [number, number] } {
  const data = new Uint16Array(field.data.length);
  for (let i = 0; i < data.length; i++) data[i] = encode16(field.data[i]!, range);
  return { data, range };
}

/** Bilinear sample of the field in pixel coordinates; used by tests and tooling. */
export function sampleField(field: SignedDistanceField, x: number, y: number): number {
  const { data, width, height } = field;
  const cx = Math.max(0, Math.min(width - 1, x));
  const cy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = data[y0 * width + x0]! * (1 - fx) + data[y0 * width + x1]! * fx;
  const b = data[y1 * width + x0]! * (1 - fx) + data[y1 * width + x1]! * fx;
  return a * (1 - fy) + b * fy;
}
