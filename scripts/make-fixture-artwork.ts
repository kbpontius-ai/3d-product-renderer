/**
 * Generates the fixture artwork assets the demo editor and tests consume.
 *
 * It runs the real derived-asset path — coverage mask -> signed distance field -> PNGs with
 * metadata — so the app is fed exactly the shapes production will feed it. The only stand-in is the
 * source: instead of rasterising an uploaded SVG (which happens server-side with resvg, see
 * docs/14-artwork-pipeline.md), the mask is drawn from analytic shapes.
 *
 * Usage: node --experimental-strip-types scripts/make-fixture-artwork.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFieldTo16, signedDistanceFieldMm } from '@pr/artwork';
import { encodeGray16Png, encodeGray8Png } from '@pr/artwork/png';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Shape = (x: number, y: number) => number; // signed distance in mm, negative inside

const circle =
  (cx: number, cy: number, r: number): Shape =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - r;

const box =
  (cx: number, cy: number, hw: number, hh: number, radius = 0): Shape =>
  (x, y) => {
    const dx = Math.abs(x - cx) - hw + radius;
    const dy = Math.abs(y - cy) - hh + radius;
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - radius;
  };

const union =
  (...shapes: Shape[]): Shape =>
  (x, y) =>
    Math.min(...shapes.map((s) => s(x, y)));

const subtract =
  (a: Shape, b: Shape): Shape =>
  (x, y) =>
    Math.max(a(x, y), -b(x, y));

/** A ring with a crossbar: enough structure to show bevels, thin strokes and edge quality. */
function monogram(widthMm: number, heightMm: number): Shape {
  const cx = widthMm / 2;
  const cy = heightMm / 2;
  const ring = subtract(circle(cx, cy, 6.5), circle(cx, cy, 4.2));
  const bar = box(cx, cy, 11, 1.1, 0.4);
  const tick = box(cx + 13.5, cy, 1.4, 3.4, 0.5);
  const thin = box(cx - 13.6, cy, 1.2, 0.28, 0.1); // deliberately below a 0.3 mm process limit
  return union(ring, bar, tick, thin);
}

function rasterize(shape: Shape, widthMm: number, heightMm: number, mmPerPx: number) {
  const width = Math.round(widthMm / mmPerPx);
  const height = Math.round(heightMm / mmPerPx);
  const data = new Uint8Array(width * height);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const x = (px + 0.5) * mmPerPx;
      const y = (py + 0.5) * mmPerPx;
      // Antialias by converting the distance to pixel coverage across one texel.
      const coverage = Math.max(0, Math.min(1, 0.5 - shape(x, y) / mmPerPx));
      data[py * width + px] = Math.round(coverage * 255);
    }
  }
  return { data, width, height };
}

const NATURAL_SIZE_MM = { w: 32, h: 16 };
const MM_PER_PX = 0.04; // 25 px/mm: plenty for a 32 mm mark, small enough to keep the repo light

const mask = rasterize(monogram(NATURAL_SIZE_MM.w, NATURAL_SIZE_MM.h), NATURAL_SIZE_MM.w, NATURAL_SIZE_MM.h, MM_PER_PX);
const field = signedDistanceFieldMm(mask, MM_PER_PX);
const encoded = encodeFieldTo16(field);

const outDir = join(ROOT, 'fixtures', 'artwork', 'monogram');
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, 'mask.png'),
  encodeGray8Png(mask.data, mask.width, mask.height, [
    { key: 'mmPerPx', value: String(MM_PER_PX) },
    { key: 'Software', value: '3d-product-renderer artwork pipeline' },
  ]),
);

writeFileSync(
  join(outDir, 'sdf.png'),
  encodeGray16Png(encoded.data, field.width, field.height, [
    { key: 'mmPerPx', value: String(MM_PER_PX) },
    { key: 'sdfRangeMm', value: `${encoded.range[0]},${encoded.range[1]}` },
  ]),
);

let coveredPixels = 0;
for (const v of mask.data) coveredPixels += v / 255;

const meta = {
  key: 'monogram',
  name: 'Monogram (fixture)',
  naturalSizeMm: NATURAL_SIZE_MM,
  mmPerPx: MM_PER_PX,
  widthPx: field.width,
  heightPx: field.height,
  sdfRangeMm: [Number(encoded.range[0].toFixed(6)), Number(encoded.range[1].toFixed(6))],
  stats: {
    coverage: Number((coveredPixels / mask.data.length).toFixed(4)),
    minStrokeMm: 0.56, // the thin tick: 2 x its half-width, used to exercise thin-stroke warnings
  },
};
writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

console.log(`wrote ${field.width}x${field.height} fixture artwork to ${outDir}`);
console.log(`  sdf range: ${meta.sdfRangeMm.join(' .. ')} mm, coverage ${meta.stats.coverage}`);
