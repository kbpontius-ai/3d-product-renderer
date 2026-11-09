/**
 * Renders one sample design with Cycles, end to end, and writes the result where you point it.
 *
 * The quickest way to see whether the render path actually works on this machine — it uses the same
 * bake, the same generated scene and the same runner the worker does, with the fixture cap and a
 * synthetic monogram.
 *
 *   pnpm render:sample .tmp/sample
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode16, signedDistanceFieldMm } from '@pr/artwork';
import { prepareArtwork } from '@pr/svg';
import { choosePitchMm, rasterizeArtwork } from '@pr/raster';
import { encodeGray16Png, encodeGray8Png } from '@pr/artwork/png';
import { validatePack, type RenderSpec } from '@pr/design-schema';
import { boundingSphere, framePreset } from '@pr/scene';
import { bakeSpec, buildSceneJob, probeBlender, runScene, type ArtworkSource } from '@pr/blender';

const REPO = process.cwd();
const OUT = process.argv[2]!;
const manifest = validatePack(JSON.parse(readFileSync(join(REPO, 'fixtures/packs/cap-basic/manifest.json'), 'utf8'))).manifest;
const product = manifest.products[0]!;
const variant = product.variants[0]!;
const zone = variant.zones.find((z) => z.key === 'top')!;
const camera = framePreset(variant.cameraPresets.find((p) => p.key === (process.env['PRESET_KEY'] ?? 'three-quarter')) ?? variant.cameraPresets[0]!, boundingSphere(variant.dimensionsMm.bbox));

/**
 * The mark to place: an SVG through the real pipeline, or a synthetic monogram.
 *
 *   ARTWORK=fixtures/artwork/samples/wordmark.svg pnpm render:sample .tmp/sample
 */
function artwork(): { source: ArtworkSource; maskPng: Uint8Array } {
  const file = process.env['ARTWORK'];
  const mask = file ? fromSvg(readFileSync(file, 'utf8')) : monogramMask();

  const field = signedDistanceFieldMm(mask, mask.mmPerPx);
  const range: [number, number] = [field.minMm, field.maxMm];
  const enc = new Uint16Array(field.data.length);
  for (let i = 0; i < enc.length; i++) enc[i] = encode16(field.data[i]!, range);

  const maskPng = encodeGray8Png(mask.data, mask.width, mask.height);
  return {
    source: { sdfPng: encodeGray16Png(enc, mask.width, mask.height), sdfRangeMm: range, maskPng },
    maskPng,
  };
}

function fromSvg(svg: string): { data: Uint8Array; width: number; height: number; mmPerPx: number } {
  const prepared = prepareArtwork(svg);
  if (prepared.status !== 'ready' || !prepared.artwork) {
    throw new Error(`artwork rejected: ${prepared.report.errors.map((e) => e.code).join(', ')}`);
  }
  const longest = Math.max(prepared.report.stats.contentBbox.w, prepared.report.stats.contentBbox.h);
  const raster = rasterizeArtwork(prepared.artwork, { mmPerPx: choosePitchMm(longest), maxSidePx: 1024 });
  if (!raster) throw new Error('artwork has nothing to place');
  return { ...raster.mask, mmPerPx: raster.mmPerPx };
}

function monogramMask(): { data: Uint8Array; width: number; height: number; mmPerPx: number } {
  const w = 256, h = 128, mmPerPx = 0.12;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = x - w / 2, cy = y - h / 2;
    const ring = Math.abs(Math.hypot(cx, cy) - 40) < 7;
    const bar = Math.abs(cy) < 6 && Math.abs(cx) < 80;
    data[y * w + x] = ring || bar ? 255 : 0;
  }
  return { data, width: w, height: h, mmPerPx };
}

const spec: RenderSpec = {
  specVersion: 1,
  document: {
    schemaVersion: 1, units: 'mm',
    product: { packKey: manifest.key, packVersion: manifest.version, productKey: product.key, variantKey: variant.key },
    materials: { body: { materialKey: 'pp-matte', colorHex: '#1b4d3e', textureScale: 1, textureRotationDeg: 0 } },
    placements: [{
      id: '55555555-5555-4555-8555-555555555555', zoneKey: 'top',
      artwork: { artworkId: '11111111-1111-4111-8111-111111111111', versionId: 'v1' as never },
      transform: { offsetMm: { x: Number(process.env['OFFSET_X'] ?? 0), y: Number(process.env['OFFSET_Y'] ?? 0) }, sizeMm: { w: Number(process.env['SIZE_W'] ?? 22), h: Number(process.env['SIZE_H'] ?? 11) }, rotationDeg: 0, flipX: false, flipY: false, lockAspect: true },
      finish: { kind: 'deboss', depthMm: Number(process.env['DEPTH'] ?? 0.4), bevelDeg: 35, edgeRadiusMm: 0.05 }, order: 0,
    }],
    scene: { environmentKey: 'studio-softbox', environmentRotationDeg: 0, exposureEv: 0, background: { kind: 'studio' }, camera: { kind: 'preset', presetKey: 'macro-logo' } },
    annotations: {},
  },
  resolved: {
    meshKey: 'x', meshDigest: 'a'.repeat(64),
bboxMm: variant.dimensionsMm.bbox, zones: [zone],
    artwork: [{ versionId: 'v1' as never, maskKey: 'm', sdfKey: 's', sdfRangeMm: [-2, 3], mmPerPx: 0.12, digest: 'b'.repeat(64) }],
    materials: manifest.materials.filter((m) => m.key === 'pp-matte').map((m) => ({ key: m.key, version: m.version, definition: m })),
    environment: { key: 'studio-softbox', hdriKey: 'builtin:studio-softbox', rotationDeg: 0, exposureEv: 0 },
  },
  outputs: [{ kind: 'image', widthPx: Number(process.env['PX'] ?? 640), heightPx: Number(process.env['PX'] ?? 640), format: 'png8', alpha: false,
    camera: process.env['CAMERA'] === 'above'
      // Above and pulled towards +z, so the roll is unambiguous: world +x is to the right of the
      // frame and world +z is towards the bottom.
      ? { kind: 'custom', positionMm: [0, 150, 40], targetMm: [0, 18, 0], upMm: [0, 1, 0], focalMm: 85, sensorMm: 36 }
      : { kind: 'custom', positionMm: camera.positionMm, targetMm: camera.targetMm, upMm: camera.upMm, focalMm: camera.focalMm, sensorMm: camera.sensorMm } }],
  quality: {
    preset: (process.env['PRESET'] as 'draft' | 'standard' | 'final') ?? 'draft',
    samples: Number(process.env['SAMPLES'] ?? 64),
    maxBounces: 6,
    denoiser: 'none',
    adaptiveThreshold: 0.02,
    displacement: {
      mode: (process.env['DISPLACE'] as 'bump' | 'displacement') ?? 'bump',
      dicingRate: Number(process.env['DICING'] ?? 2),
    },
  },
  seed: 3, renderer: { id: 'cycles', version: '4.0.2' }, limits: { maxWallClockSec: 900, maxVramMb: 8192 },
};

async function main() {
  await mkdir(join(OUT, 'baked'), { recursive: true });
  const { source, maskPng } = artwork();
  await writeFile(join(OUT, 'mask.png'), maskPng);
  const baked = bakeSpec(spec, new Map([['v1', source]]));
  await mkdir(join(OUT, 'out'), { recursive: true });
  await writeFile(join(OUT, 'baked', baked[0]!.fileName), baked[0]!.png);

  const probe = await probeBlender();
  if (!probe.available) {
    console.error('no Blender on PATH; set BLENDER_PATH or install it');
    process.exitCode = 1;
    return;
  }

  const result = await runScene(
    buildSceneJob({
      spec,
      meshPath: join(REPO, 'fixtures/packs/cap-basic/meshes/cap-flat/38mm/render.glb'),
      baked,
      bakedDir: join(OUT, 'baked'),
      outputDir: join(OUT, 'out'),
      denoiserAvailable: probe.denoiser,
      bboxMm: variant.dimensionsMm.bbox,
    }),
    {
      scratchDir: join(OUT, 'work'),
      timeoutSec: 900,
      onProgress: (stage, fraction) => console.log(' ', stage, fraction.toFixed(2)),
    },
  );

  console.log(`${result.status} in ${result.seconds.toFixed(1)}s -> ${join(OUT, 'out', 'output-0.png')}`);
  if (result.status !== 'ok') {
    console.error(result.tail.join('\n'));
    process.exitCode = 1;
  }
}

void main();
