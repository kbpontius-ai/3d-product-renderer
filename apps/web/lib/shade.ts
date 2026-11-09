import {
  dHeightdD,
  heightMm,
  signedDistanceFieldMm,
  type FinishParams,
  type Gray,
  type SignedDistanceField,
} from '@pr/artwork';

/**
 * Client-side emboss preview (F-EDIT-04).
 *
 * "Matches the path-traced result within the parity budget" is the acceptance, and it is measured
 * rather than asserted: `apps/web/e2e/parity.spec.ts` scores a preview against a real Cycles render
 * of the same design.
 *
 * The relief is shaded from the artwork's signed distance field using the SAME height profile the
 * render worker bakes and the (upcoming) WebGL shader evaluates — see docs/16-preview-engine.md.
 * This is a 2D stand-in for the GPU path, not a second definition of what emboss means: change
 * `packages/artwork/profile.ts` and this preview changes with it.
 */

export interface ShadeOptions {
  finish: FinishParams | null;
  /** Part colour, used for blind relief where the artwork is the same material as the product. */
  partColorHex: string;
  /** Preserve an already-lit surface color; only edge normals add contrast. */
  matchSurfaceColor?: boolean;
  /** Ink/foil colour for printed artwork or tinted relief. */
  inkColorHex?: string | undefined;
  /** Light azimuth in degrees, measured counter-clockwise from +x. */
  lightAzimuthDeg?: number;
  lightElevation?: number;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The distance field is derived once per artwork; finish changes only re-shade. */
export function fieldFromMask(mask: Gray, mmPerPx: number): SignedDistanceField {
  return signedDistanceFieldMm(mask, mmPerPx);
}

export function shadeArtwork(
  field: SignedDistanceField,
  mask: Gray,
  options: ShadeOptions,
): ImageData {
  const { width, height, mmPerPx } = field;
  const out = new ImageData(width, height);
  const pixels = out.data;

  const [pr, pg, pb] = hexToRgb(options.partColorHex);
  const [ir, ig, ib] = hexToRgb(options.inkColorHex ?? options.partColorHex);

  const azimuth = ((options.lightAzimuthDeg ?? 135) * Math.PI) / 180;
  const lz = options.lightElevation ?? 0.85;
  const lx = Math.cos(azimuth);
  const ly = Math.sin(azimuth);
  const lLen = Math.hypot(lx, ly, lz);
  const L: [number, number, number] = [lx / lLen, ly / lLen, lz / lLen];
  // Half-vector against a viewer straight on, for a cheap specular term.
  const H: [number, number, number] = [L[0] / 2, L[1] / 2, (L[2] + 1) / 2];
  const hLen = Math.hypot(H[0], H[1], H[2]);
  H[0] /= hLen;
  H[1] /= hLen;
  H[2] /= hLen;
  const flatDiffuse = 0.28 + 0.72 * L[2];
  const flatSpecular = Math.pow(Math.max(0, H[2]), 48) * 0.45;

  const sampleSdf = (x: number, y: number): number => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    return field.data[cy * width + cx]!;
  };

  const printed = options.finish === null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const coverage = mask.data[i]! / 255;
      const o = i * 4;

      if (coverage <= 0.002) {
        pixels[o + 3] = 0;
        continue;
      }

      if (printed) {
        pixels[o] = ir;
        pixels[o + 1] = ig;
        pixels[o + 2] = ib;
        pixels[o + 3] = Math.round(coverage * 255);
        continue;
      }

      const finish = options.finish!;
      const d = field.data[i]!;
      const slope = dHeightdD(d, finish);

      // |grad(sdf)| = 1, so the surface gradient is dh/dd times the field's own gradient.
      // Note the y flip: image rows increase downward, the light vector is in y-up space.
      const gx = (sampleSdf(x + 1, y) - sampleSdf(x - 1, y)) / (2 * mmPerPx);
      const gy = -(sampleSdf(x, y + 1) - sampleSdf(x, y - 1)) / (2 * mmPerPx);

      let nx = -slope * gx;
      let ny = -slope * gy;
      const nLen = Math.hypot(nx, ny, 1);
      nx /= nLen;
      ny /= nLen;
      const nz = 1 / nLen;

      const diffuse = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const specular = Math.pow(Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]), 48) * 0.45;
      // Relief that rises catches light; relief that sinks picks up occlusion in its floor.
      const relief = heightMm(d, finish) / Math.max(finish.depthMm, 1e-6);
      const ao = finish.kind === 'deboss' ? 0.82 + 0.18 * (1 + relief) : 1;

      const shade = (channel: number) =>
        Math.max(
          0,
          Math.min(255, Math.round((channel * (0.28 + 0.72 * diffuse) + specular * 255) * ao)),
        );

      const matchedShade = (channel: number) =>
        Math.max(
          0,
          Math.min(
            255,
            Math.round(
              ((channel * (0.28 + 0.72 * diffuse)) / flatDiffuse +
                (specular - flatSpecular) * 255) *
                ao,
            ),
          ),
        );
      const shadeChannel =
        options.matchSurfaceColor && options.inkColorHex === undefined ? matchedShade : shade;
      const useInk = options.inkColorHex !== undefined;
      pixels[o] = shadeChannel(useInk ? ir : pr);
      pixels[o + 1] = shadeChannel(useInk ? ig : pg);
      pixels[o + 2] = shadeChannel(useInk ? ib : pb);
      pixels[o + 3] = Math.round(coverage * 255);
    }
  }

  return out;
}

/** Widest relief the schema permits, and the encode range used when nothing narrower is known. */
export const HEIGHT_LAYER_RANGE_MM = 1.5;

/** Narrowest encode range worth using; below this the quantisation stops being the limit. */
export const MIN_HEIGHT_LAYER_RANGE_MM = 0.2;

/**
 * The encode range for a given relief depth.
 *
 * The height layer is an 8-bit canvas, so the range fixes the step size: at the old fixed 1.5 mm it
 * was 0.0118 mm per code, which is invisible under a bump shader and is *terracing* once the layer
 * displaces real geometry — a 0.3 mm emboss gets 25 discrete levels and every one of them is a step
 * you can see on the wall. Sixteen-bit packing across two channels is the usual fix and is wrong
 * here: the layer is composited with `drawImage`, and bilinear filtering across a low-byte wrap
 * produces garbage at exactly the edges that matter (24-displaced-preview.md, decision 7).
 *
 * Narrowing the range costs nothing and is filter-safe. The headroom is for the fillet overshoot
 * and for a depth the user is in the middle of dragging upward.
 */
export function heightLayerRangeMm(depthMm: number | null | undefined): number {
  if (!depthMm || !Number.isFinite(depthMm) || depthMm <= 0) return MIN_HEIGHT_LAYER_RANGE_MM;
  return Math.min(HEIGHT_LAYER_RANGE_MM, Math.max(MIN_HEIGHT_LAYER_RANGE_MM, depthMm * 1.25));
}

/**
 * Height layer for the 3D preview: R carries the relief height, A the coverage.
 *
 * The 3D shader displaces the zone patch by this and differentiates it for the residual shading,
 * which is why the texture stores geometry rather than a shaded image — the 3D scene must light the
 * relief with its own environment, not with the 2D view's fixed key light.
 *
 * `rangeMm` must be the same number the shader decodes with; the editor derives it once from the
 * finish and passes it to both.
 */
export function heightArtwork(
  field: SignedDistanceField,
  mask: Gray,
  finish: FinishParams | null,
  rangeMm: number = HEIGHT_LAYER_RANGE_MM,
): ImageData {
  const { width, height } = field;
  const out = new ImageData(width, height);
  const pixels = out.data;
  const range = rangeMm > 0 ? rangeMm : HEIGHT_LAYER_RANGE_MM;

  for (let i = 0; i < width * height; i++) {
    const coverage = mask.data[i]! / 255;
    const o = i * 4;
    if (!finish || coverage <= 0.002) {
      pixels[o] = 128; // zero height
      pixels[o + 3] = 0;
      continue;
    }
    const mm = heightMm(field.data[i]!, finish);
    const encoded = Math.max(0, Math.min(255, Math.round((mm / range / 2 + 0.5) * 255)));
    pixels[o] = encoded;
    pixels[o + 1] = encoded;
    pixels[o + 2] = encoded;
    pixels[o + 3] = Math.round(coverage * 255);
  }
  return out;
}

/** Flat ink layer: colour plus coverage, with no baked lighting. */
export function inkArtwork(mask: Gray, colorHex: string, opacity = 1): ImageData {
  const out = new ImageData(mask.width, mask.height);
  const [r, g, b] = hexToRgb(colorHex);
  for (let i = 0; i < mask.data.length; i++) {
    const o = i * 4;
    out.data[o] = r;
    out.data[o + 1] = g;
    out.data[o + 2] = b;
    out.data[o + 3] = Math.round((mask.data[i]! / 255) * opacity * 255);
  }
  return out;
}

/** Reads an image URL into a single-channel coverage mask, the pipeline's canonical form. */
export async function loadMask(url: string): Promise<Gray> {
  const image = new Image();
  image.src = url;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.drawImage(image, 0, 0);

  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]!; // greyscale: any channel will do

  return { data, width: canvas.width, height: canvas.height };
}
