import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encode16, signedDistanceFieldMm } from '@pr/artwork';
import { decodePng, encodeGray16Png, encodeGray8Png } from '@pr/artwork/png';
import type { DecorationZoneDef, RenderSpec } from '@pr/design-schema';
import { validatePack } from '@pr/design-schema';
import { boundingSphere, framePreset, frameFromDirections } from '@pr/scene';
import { encodeGlb, type MeshData } from '@pr/gltf';
import { describeRenderBackend } from '@pr/render-backend/testing';
import { bakeSpec, type ArtworkSource } from './bake.js';
import { buildSceneJob } from './scene.js';
import { cyclesLocal } from './backend.js';
import { probeBlender, runScene } from './run.js';

/**
 * The render path, end to end: a design becomes pixels.
 *
 * This is the only test that runs Blender. It renders small and cheap, because what is being
 * checked is that the generated scene is valid — that the mesh imports, the zone nodes link, the
 * displacement decodes and Cycles produces an image — not how pretty the result is.
 *
 * Skipped where Blender is not installed, which is most laptops and no CI runner that matters.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const MANIFEST = JSON.parse(
  readFileSync(join(REPO, 'fixtures/packs/cap-basic/manifest.json'), 'utf8'),
) as unknown;

const probe = await probeBlender();

const ARTWORK_VERSION = '22222222-2222-4222-8222-222222222222';

/**
 * Above the product and pulled towards +z, so the frame's axes are unambiguous: the zone's +x is to
 * the right and its +y towards the top. A camera looking straight down would leave the roll free.
 */
const ABOVE = {
  positionMm: [0, 150, 40] as [number, number, number],
  // Aimed at the decorated face itself, so the mark sits in the middle of the frame.
  targetMm: [0, 18, 0] as [number, number, number],
  upMm: [0, 1, 0] as [number, number, number],
  focalMm: 85,
  sensorMm: 36,
};

if (process.env['CI'] && !probe.available) {
  throw new Error('CI renderer integration tests require a usable Blender executable');
}

describe.skipIf(!probe.available)(`blender ${probe.version ?? ''}`.trim(), () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pr-render-'));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('imports a legacy leading empty mesh and targets the surviving material without rewriting the source', async () => {
    const source = await readFile(
      join(REPO, 'fixtures/packs/cap-basic/meshes/cap-flat/38mm/render.glb'),
    );
    const length = source.readUInt32LE(12);
    const parsed: unknown = JSON.parse(source.toString('utf8', 20, 20 + length));
    const json = parsed as {
      accessors: {
        count: number;
        bufferView: number;
        componentType: number;
        type: string;
        min?: (number | null)[];
        max?: (number | null)[];
      }[];
      bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
      meshes: {
        primitives: { attributes: Record<string, number>; indices: number; material?: number }[];
      }[];
      nodes: { mesh: number }[];
      scenes: { nodes: number[] }[];
    };
    json.accessors.push({
      count: 0,
      bufferView: json.bufferViews.length,
      componentType: 5126,
      type: 'VEC3',
      min: [null, null, null],
      max: [null, null, null],
    });
    json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 0 });
    json.meshes.unshift({
      primitives: [
        { attributes: { POSITION: json.accessors.length - 1 }, indices: json.accessors.length - 1 },
      ],
    });
    for (const node of json.nodes) node.mesh++;
    json.nodes.push({ mesh: 0 });
    json.scenes[0]!.nodes.push(json.nodes.length - 1);
    const bytes = Buffer.from(JSON.stringify(json));
    const padded = Buffer.alloc((bytes.length + 3) & ~3, 0x20);
    bytes.copy(padded);
    const header = Buffer.from(source.subarray(0, 20));
    const binary = source.subarray(20 + length);
    header.writeUInt32LE(padded.length, 12);
    header.writeUInt32LE(20 + padded.length + binary.length, 8);
    const legacy = Buffer.concat([header, padded, binary]);
    const meshPath = join(scratch, 'legacy.glb');
    await writeFile(meshPath, legacy);
    const { spec } = capSpec('deboss', { widthPx: 96 });
    const assignment = Object.values(spec.document.materials)[0]!;
    spec.document.materials = {
      'empty-assembly': { ...assignment },
      'cap-body': { ...assignment },
    };
    const baked = bakeSpec(spec, new Map([[ARTWORK_VERSION, discSource()]]));
    const bakedDir = await ensure(join(scratch, 'legacy-baked'));
    const outputDir = await ensure(join(scratch, 'legacy-out'));
    for (const map of baked) await writeFile(join(bakedDir, map.fileName), map.png);
    const result = await cyclesLocal().render({
      spec,
      meshPath,
      baked,
      bakedDir,
      outputDir,
      bboxMm: [
        [-19, 0, -19],
        [19, 18, 19],
      ],
      scratchDir: join(scratch, 'new-legacy-work'),
      timeoutSec: 120,
      threads: 2,
    });
    expect(result.status, result.message).toBe('ok');
    expect(await readFile(meshPath)).toEqual(legacy);
    expect((await readFile(join(outputDir, 'output-0.png'))).length).toBeGreaterThan(100);
  }, 150_000);

  it('renders a debossed cap from a spec', async () => {
    const { spec, zone } = capSpec('deboss');
    const sources = new Map<string, ArtworkSource>([[ARTWORK_VERSION, discSource()]]);

    const baked = bakeSpec(spec, sources);
    expect(baked).toHaveLength(1);
    expect(baked[0]!.kind).toBe('height');

    const bakedDir = join(scratch, 'baked');
    const outputDir = join(scratch, 'out');
    await writeFile(join(await ensure(bakedDir), baked[0]!.fileName), baked[0]!.png);
    await ensure(outputDir);

    const stages: string[] = [];
    const result = await runScene(
      buildSceneJob({
        spec,
        meshPath: join(REPO, 'fixtures/packs/cap-basic/meshes/cap-flat/38mm/render.glb'),
        baked,
        bakedDir,
        outputDir,
        denoiserAvailable: probe.denoiser,
        bboxMm: variantBbox(),
      }),
      {
        scratchDir: join(scratch, 'work'),
        timeoutSec: 600,
        onProgress: (stage) => {
          if (stages.at(-1) !== stage) stages.push(stage);
        },
      },
    );

    expect(result.status, result.tail.join('\n')).toBe('ok');
    expect(stages).toContain('build');
    expect(stages).toContain('trace');

    // A real image, and not a blank one. This is the assertion that matters: an empty frame renders
    // fine, uploads fine and tells nobody that the product was outside the camera's near plane.
    const image = decodePng(await readFile(join(outputDir, 'output-0.png')));
    expect(image.width).toBe(256);

    const lit = coverage(image);
    expect(lit.fraction).toBeGreaterThan(0.05); // the product occupies part of the frame
    expect(lit.fraction).toBeLessThan(0.95); // and does not fill all of it
    expect(lit.contrast).toBeGreaterThan(0.15); // it is shaded, not a flat card
    expect(zone.key).toBe('top');
  }, 900_000);

  it('places the mark the way the design says, not mirrored or turned around', async () => {
    // An L: a bar down the artwork's left edge, a bar along its bottom, and a small square near the
    // top left. Asymmetric in both axes, so a flip or a 180-degree turn cannot hide.
    // Printed rather than debossed: the same zone-to-artwork mapping, but ink is a colour
    // difference instead of a few pixels of shading, so the measurement is about orientation
    // rather than about how well a 0.6 mm bevel catches the light.
    const { spec } = capSpec('print', { sizeMm: 24, camera: ABOVE, widthPx: 384 });
    const baked = bakeSpec(spec, new Map([[ARTWORK_VERSION, cornerSource()]]));

    const bakedDir = join(scratch, 'baked-corner');
    const outputDir = join(scratch, 'out-corner');
    await writeFile(join(await ensure(bakedDir), baked[0]!.fileName), baked[0]!.png);
    await ensure(outputDir);

    const result = await runScene(
      buildSceneJob({
        spec,
        meshPath: join(REPO, 'fixtures/packs/cap-basic/meshes/cap-flat/38mm/render.glb'),
        baked,
        bakedDir,
        outputDir,
        denoiserAvailable: probe.denoiser,
        bboxMm: variantBbox(),
      }),
      { scratchDir: join(scratch, 'work-corner'), timeoutSec: 600 },
    );
    expect(result.status, result.tail.join('\n')).toBe('ok');

    // The camera looks down from above and slightly towards +z, so the frame's right is the zone's
    // +x and the frame's top is the zone's +y. The relief must therefore be down the left side and
    // along the bottom.
    const image = decodePng(await readFile(join(outputDir, 'output-0.png')));
    const ink = quadrantDetail(image);

    // The L covers the left side and the bottom; the top right is the one empty corner.
    expect(ink.bottomLeft).toBeGreaterThan(0.05);
    expect(ink.topLeft).toBeGreaterThan(0.05);
    expect(ink.bottomRight).toBeGreaterThan(0.05);
    expect(ink.topRight).toBeLessThan(0.01);
  }, 900_000);

  it('renders the Detail studio in the confirmed product frame', async () => {
    const frame = frameFromDirections([0, 1, 0], [0, 0, -1]);
    const camera = framePreset(
      {
        key: 'front',
        label: 'Front',
        azimuthDeg: 0,
        elevationDeg: 0,
        radiusScale: 2.4,
        focalMm: 85,
        targetOffsetMm: [0, 0, 0],
      },
      boundingSphere(variantBbox()),
      undefined,
      frame,
    );
    const { spec } = capSpec('deboss', { camera });
    spec.resolved.presentationOrientation = frame;
    spec.resolved.environment = {
      ...spec.resolved.environment,
      key: 'studio-detail-v1',
      hdriKey: 'builtin:studio-detail-v1',
    };
    spec.resolved.environment.orientation = frame;
    const legacyFrame = spec.resolved.presentationOrientation;
    delete spec.resolved.presentationOrientation;
    delete spec.resolved.environment.orientation;
    expect(
      buildSceneJob({
        spec,
        meshPath: '',
        baked: [],
        bakedDir: scratch,
        outputDir: scratch,
        denoiserAvailable: probe.denoiser,
        bboxMm: variantBbox(),
      }).data.world.upSource,
    ).toEqual([0, 1, 0]);
    spec.resolved.presentationOrientation = legacyFrame;
    spec.resolved.environment.orientation = frame;
    const baked = bakeSpec(spec, new Map([[ARTWORK_VERSION, cornerSource()]]));
    const bakedDir = await ensure(join(scratch, 'oriented-baked'));
    const outputDir = await ensure(join(scratch, 'oriented-out'));
    for (const map of baked) await writeFile(join(bakedDir, map.fileName), map.png);
    const job = buildSceneJob({
      spec,
      meshPath: join(REPO, 'fixtures/packs/cap-basic/meshes/cap-flat/38mm/render.glb'),
      baked,
      bakedDir,
      outputDir,
      denoiserAvailable: probe.denoiser,
      bboxMm: variantBbox(),
    });
    expect(job.data.world.upSource).toEqual(frame.upSource);
    const result = await runScene(job, {
      scratchDir: join(scratch, 'oriented-work'),
      timeoutSec: 600,
    });
    expect(result.status, result.tail.join('\n')).toBe('ok');
    const image = decodePng(await readFile(join(outputDir, 'output-0.png')));
    expect(image.width).toBe(256);
    expect(coverage(image).contrast).toBeGreaterThan(0.15);
  }, 900_000);

  it('retains decoration UV coordinates after Blender imports their transport name', async () => {
    const manifest = validatePack(
      JSON.parse(readFileSync(join(REPO, 'fixtures/packs/box-basic/manifest.json'), 'utf8')),
    ).manifest;
    const variant = manifest.products[0]!.variants[0]!;
    const camera = framePreset(
      variant.cameraPresets.find((p) => p.key === 'front')!,
      boundingSphere(variant.dimensionsMm.bbox),
    );
    const { spec } = capSpec('print', { camera, widthPx: 384, sizeMm: 24 });
    spec.document.materials = {
      board: {
        materialKey: 'board-coated',
        colorHex: '#1b4d3e',
        textureScale: 1,
        textureRotationDeg: 0,
      },
    };
    spec.document.placements[0]!.zoneKey = 'front';
    spec.document.placements[0]!.finish = {
      kind: 'print',
      inkMaterialKey: 'ink-cmyk',
      tintHex: '#101010',
      opacity: 1,
    };
    spec.resolved.zones = [variant.zones[0]!];
    spec.resolved.bboxMm = variant.dimensionsMm.bbox;
    spec.resolved.materials = manifest.materials
      .filter((m) => m.key === 'board-coated' || m.key === 'ink-cmyk')
      .map((m) => ({ key: m.key, version: m.version, definition: m }));
    const baked = bakeSpec(spec, new Map([[ARTWORK_VERSION, cornerSource()]]));
    const bakedDir = await ensure(join(scratch, 'uv-baked'));
    const outputDir = await ensure(join(scratch, 'uv-out'));
    for (const map of baked) await writeFile(join(bakedDir, map.fileName), map.png);
    const result = await runScene(
      buildSceneJob({
        spec,
        meshPath: join(REPO, 'fixtures/packs/box-basic/meshes/carton-tuck/std/render.glb'),
        baked,
        bakedDir,
        outputDir,
        denoiserAvailable: probe.denoiser,
        bboxMm: variant.dimensionsMm.bbox,
      }),
      { scratchDir: join(scratch, 'uv-work'), timeoutSec: 600 },
    );
    expect(result.status, result.tail.join('\n')).toBe('ok');
    const image = decodePng(await readFile(join(outputDir, 'output-0.png')));
    const distance = Math.hypot(...camera.positionMm.map((n, i) => n - camera.targetMm[i]!));
    const pxPerMm = (image.width * camera.focalMm) / (distance * camera.sensorMm);
    const brightness = (xMm: number, yMm: number) => {
      const x = Math.round(image.width / 2 + xMm * pxPerMm);
      const y = Math.round(image.height / 2 - yMm * pxPerMm);
      const offset = (y * image.width + x) * image.channels;
      return image.data[offset]! + image.data[offset + 1]! + image.data[offset + 2]!;
    };
    const bare = brightness(8.5, 8.5);
    expect(brightness(-8.5, 8.5)).toBeLessThan(bare * 0.85);
    expect(brightness(8.5, -8.5)).toBeLessThan(bare * 0.85);
  }, 900_000);

  it('keeps two parts on their own materials after joining and replacing slots', async () => {
    const panel = (left: number, right: number, material: number): MeshData => ({
      name: `panel-${material}`,
      positions: new Float32Array([left, 0, 0, right, 0, 0, right, 20, 0, left, 20, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      material,
    });
    // Reversed primitive order catches Blender's join reordering as well as clear() resetting indices.
    const meshPath = join(scratch, 'two-materials.glb');
    await writeFile(meshPath, encodeGlb(
      [panel(-20, -2, 1), panel(2, 20, 0)],
      [{ name: 'red' }, { name: 'blue' }],
    ));
    const { spec } = capSpec('print', { camera: {
      positionMm: [0, 10, 120], targetMm: [0, 10, 0], upMm: [0, 1, 0], focalMm: 65, sensorMm: 36,
    } });
    spec.document.placements = [];
    spec.document.materials = {
      red: { materialKey: 'pp-matte', colorHex: '#e01010', textureScale: 1, textureRotationDeg: 0 },
      blue: { materialKey: 'pp-matte', colorHex: '#1010e0', textureScale: 1, textureRotationDeg: 0 },
    };
    spec.resolved.bboxMm = [[-20, 0, 0], [20, 20, 0]];
    spec.resolved.zones = [];
    const outputDir = await ensure(join(scratch, 'two-materials'));
    const result = await runScene(buildSceneJob({
      spec, meshPath, baked: [], bakedDir: scratch, outputDir,
      denoiserAvailable: probe.denoiser, bboxMm: spec.resolved.bboxMm,
    }), { scratchDir: join(scratch, 'two-materials-work'), timeoutSec: 600 });
    expect(result.status, result.tail.join('\n')).toBe('ok');
    const image = decodePng(await readFile(join(outputDir, 'output-0.png')));
    const counts = { leftBlue: 0, leftRed: 0, rightBlue: 0, rightRed: 0 };
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * image.channels;
        const r = image.data[i]!, b = image.data[i + 2]!;
        const side = x < image.width / 2 ? 'left' : 'right';
        if (r > b * 2 && r > 30) counts[`${side}Red`]++;
        if (b > r * 2 && b > 30) counts[`${side}Blue`]++;
      }
    }
    expect(counts.leftBlue).toBeGreaterThan(500);
    expect(counts.rightRed).toBeGreaterThan(500);
    expect(counts.leftRed).toBe(0);
    expect(counts.rightBlue).toBe(0);
  }, 900_000);

  it('reports a missing mesh instead of failing inside Blender', async () => {
    const { spec } = capSpec('deboss');
    const result = await runScene(
      buildSceneJob({
        spec,
        meshPath: join(scratch, 'not-here.glb'),
        baked: [],
        bakedDir: scratch,
        outputDir: scratch,
        denoiserAvailable: probe.denoiser,
        bboxMm: variantBbox(),
      }),
      { scratchDir: join(scratch, 'work2'), timeoutSec: 60 },
    );

    expect(result.status).toBe('failed');
    expect(result.message).toContain('mesh not found');
  });
});

describe('probeBlender', () => {
  it('says so when there is no renderer, rather than throwing', async () => {
    expect(await probeBlender('/definitely/not/blender')).toEqual({
      available: false,
      denoiser: false,
    });
  });
});

// -----------------------------------------------------------------------------------------------

/**
 * How much of the frame is not background, and how much tonal range it spans.
 *
 * The background is the darkest thing in a studio render, so "brighter than the darkest corner" is
 * a good enough definition of the subject for a smoke test.
 */
function coverage(image: { data: Uint8Array | Uint16Array; channels: number }): {
  fraction: number;
  contrast: number;
} {
  const max = image.data instanceof Uint16Array ? 65535 : 255;
  const luminance: number[] = [];
  for (let i = 0; i < image.data.length; i += image.channels) {
    const r = image.data[i]! / max;
    const g = image.data[i + (image.channels > 1 ? 1 : 0)]! / max;
    const b = image.data[i + (image.channels > 2 ? 2 : 0)]! / max;
    luminance.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }

  const darkest = Math.min(...luminance);
  const brightest = Math.max(...luminance);
  const threshold = darkest + (brightest - darkest) * 0.25;

  return {
    fraction: luminance.filter((l) => l > threshold).length / luminance.length,
    contrast: brightest - darkest,
  };
}

const variantBbox = () =>
  validatePack(MANIFEST).manifest.products[0]!.variants[0]!.dimensionsMm.bbox;

async function ensure(dir: string): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * How much ink covers each quadrant of the frame.
 *
 * Ink is much darker than the part, so "is the mark here" is a brightness question. Only the middle
 * of the frame is measured: the product's silhouette against the background is darker than any ink
 * and would otherwise decide the answer.
 */
function quadrantDetail(image: {
  data: Uint8Array | Uint16Array;
  width: number;
  height: number;
  channels: number;
}): { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number } {
  const max = image.data instanceof Uint16Array ? 65535 : 255;
  const half = { x: image.width / 2, y: image.height / 2 };
  const buckets: number[][] = [[], [], [], []];

  // Only the middle of the frame: the product's silhouette against the background varies far more
  // than any relief does, and it would drown out the thing being measured.
  const margin = { x: image.width * 0.28, y: image.height * 0.28 };

  const luminance = (x: number, y: number): number => {
    const i = (y * image.width + x) * image.channels;
    return (
      (0.2126 * image.data[i]! + 0.7152 * image.data[i + 1]! + 0.0722 * image.data[i + 2]!) / max
    );
  };

  let brightest = 0;
  for (let y = Math.round(margin.y); y < image.height - margin.y; y++) {
    for (let x = Math.round(margin.x); x < image.width - margin.x; x++) {
      brightest = Math.max(brightest, luminance(x, y));
    }
  }

  // "Inked" means clearly darker than the bare part around it.
  for (let y = Math.round(margin.y); y < image.height - margin.y; y++) {
    for (let x = Math.round(margin.x); x < image.width - margin.x; x++) {
      const inked = luminance(x, y) < brightest * 0.55 ? 1 : 0;
      buckets[(y < half.y ? 0 : 2) + (x < half.x ? 0 : 1)]!.push(inked);
    }
  }

  const coverage = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

  return {
    topLeft: coverage(buckets[0]!),
    topRight: coverage(buckets[1]!),
    bottomLeft: coverage(buckets[2]!),
    bottomRight: coverage(buckets[3]!),
  };
}

/** The L probe: left bar, bottom bar, and a small square near the top left. */
function cornerSource(): ArtworkSource {
  const size = 96;
  const mmPerPx = 0.25;
  const data = new Uint8Array(size * size);
  const bar = Math.round(size * 0.14);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const leftBar = x >= 6 && x < 6 + bar && y >= 6 && y < size - 6;
      const bottomBar = y >= size - 6 - bar && y < size - 6 && x >= 6 && x < size - 6;
      const square = x > size * 0.3 && x < size * 0.42 && y > size * 0.08 && y < size * 0.2;
      data[y * size + x] = leftBar || bottomBar || square ? 255 : 0;
    }
  }

  const field = signedDistanceFieldMm({ data, width: size, height: size }, mmPerPx);
  const range: [number, number] = [field.minMm, field.maxMm];
  const encoded = new Uint16Array(field.data.length);
  for (let i = 0; i < encoded.length; i++) encoded[i] = encode16(field.data[i]!, range);

  return {
    sdfPng: encodeGray16Png(encoded, size, size),
    sdfRangeMm: range,
    maskPng: encodeGray8Png(data, size, size),
  };
}

/** A small filled disc, standing in for a logo. */
function discSource(): ArtworkSource {
  const width = 64;
  const height = 64;
  const mmPerPx = 0.25;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = Math.hypot(x - width / 2, y - height / 2) < 22 ? 255 : 0;
    }
  }

  const field = signedDistanceFieldMm({ data, width, height }, mmPerPx);
  const range: [number, number] = [field.minMm, field.maxMm];
  const encoded = new Uint16Array(field.data.length);
  for (let i = 0; i < encoded.length; i++) encoded[i] = encode16(field.data[i]!, range);

  return {
    sdfPng: encodeGray16Png(encoded, width, height),
    sdfRangeMm: range,
    maskPng: encodeGray8Png(data, width, height),
  };
}

interface CapSpecOptions {
  sizeMm?: number;
  camera?: typeof ABOVE;
  widthPx?: number;
  depthMm?: number;
}

function capSpec(
  kind: 'emboss' | 'deboss' | 'print',
  options: CapSpecOptions = {},
): { spec: RenderSpec; zone: DecorationZoneDef } {
  const manifest = validatePack(MANIFEST).manifest;
  const product = manifest.products[0]!;
  const variant = product.variants[0]!;
  const zone = variant.zones.find((z) => z.key === 'top')!;
  // The same framing function the preview uses, so what is rendered is what was previewed.
  const camera = framePreset(variant.cameraPresets[0]!, boundingSphere(variant.dimensionsMm.bbox));

  const spec: RenderSpec = {
    specVersion: 1,
    document: {
      schemaVersion: 1,
      units: 'mm',
      product: {
        packKey: manifest.key,
        packVersion: manifest.version,
        productKey: product.key,
        variantKey: variant.key,
      },
      materials: {
        body: {
          materialKey: 'pp-matte',
          colorHex: '#1b4d3e',
          textureScale: 1,
          textureRotationDeg: 0,
        },
      },
      placements: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          zoneKey: 'top',
          artwork: {
            artworkId: '11111111-1111-4111-8111-111111111111',
            versionId: '22222222-2222-4222-8222-222222222222',
          },
          transform: {
            offsetMm: { x: 0, y: 0 },
            sizeMm: { w: options.sizeMm ?? 16, h: options.sizeMm ?? 16 },
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            lockAspect: true,
          },
          finish:
            kind === 'print'
              ? { kind, inkMaterialKey: 'ink-black', tintHex: '#101010', opacity: 1 }
              : { kind, depthMm: options.depthMm ?? 0.35, bevelDeg: 30, edgeRadiusMm: 0.05 },
          order: 0,
        },
      ],
      scene: {
        environmentKey: 'studio-softbox',
        environmentRotationDeg: 0,
        exposureEv: 0,
        background: { kind: 'studio' },
        camera: { kind: 'preset', presetKey: variant.cameraPresets[0]!.key },
      },
      annotations: {},
    },
    resolved: {
      meshKey: 'packs/cap-basic/1.0.0/meshes/cap-flat/38mm/render.glb',
      meshDigest: 'a'.repeat(64),
      bboxMm: variant.dimensionsMm.bbox,
      zones: [zone],
      artwork: [
        {
          versionId: '22222222-2222-4222-8222-222222222222',
          maskKey: 'artwork/x/mask.png',
          sdfKey: 'artwork/x/sdf.png',
          sdfRangeMm: [-2, 3],
          mmPerPx: 0.25,
          digest: 'b'.repeat(64),
        },
      ],
      materials: manifest.materials
        .filter((m) => m.key === 'pp-matte')
        .map((m) => ({ key: m.key, version: m.version, definition: m })),
      environment: {
        key: 'studio-softbox',
        hdriKey: 'builtin:studio-softbox',
        rotationDeg: 0,
        exposureEv: 0,
      },
    },
    outputs: [
      {
        kind: 'image',
        widthPx: options.widthPx ?? 256,
        heightPx: options.widthPx ?? 256,
        format: 'png8',
        alpha: false,
        camera: { kind: 'custom', ...(options.camera ?? camera) },
      },
    ],
    quality: {
      preset: 'draft',
      samples: 16,
      maxBounces: 4,
      denoiser: 'none',
      adaptiveThreshold: 0.05,
      displacement: { mode: 'bump', dicingRate: 2 },
    },
    seed: 1,
    renderer: { id: 'cycles', version: probe.version ?? '0' },
    limits: { maxWallClockSec: 600, maxVramMb: 4096 },
  };

  return { spec, zone };
}

/**
 * The renderer contract, against the renderer that ships (F-GEN-04).
 *
 * The same cases the fake backend passes, so "Cycles satisfies the contract" is a checked claim
 * rather than an assertion in a comment. Rendered small: what is under test is the behaviour a
 * supervisor depends on — progress, cancellation, deadlines, honest failure — not image quality.
 */
describeRenderBackend({
  name: 'cycles-local',
  skipIf: !probe.available,
  make: () => cyclesLocal(),
  timeoutMs: 300_000,
  request: async (base) => {
    const { spec } = capSpec('deboss', { widthPx: 96 });
    const baked = bakeSpec(spec, new Map([[ARTWORK_VERSION, discSource()]]));
    for (const map of baked) await writeFile(join(base.bakedDir, map.fileName), map.png);

    return {
      ...base,
      spec,
      meshPath: join(REPO, 'fixtures/packs/cap-basic/meshes/cap-flat/38mm/render.glb'),
      baked,
    };
  },
});
