import { describe, expect, it } from 'vitest';
import type { RenderSpec } from '@pr/design-schema';
import { buildSceneJob } from './scene.js';

/**
 * Tiled material textures reaching the renderer (F-MAT-04).
 *
 * The interesting parts are the ones a screenshot would not show: that tiling is physical rather
 * than per-unwrap, that the design's scale multiplies it, and that a texture the supervisor could
 * not fetch leaves the material rendering from its numbers instead of failing the job.
 */

const material = (maps: Record<string, unknown>) => ({
  key: 'board-linen',
  definition: {
    key: 'board-linen',
    name: 'Linen board',
    version: 1,
    family: 'paperboard' as const,
    colorizable: true,
    base: {
      baseColorHex: '#cccccc',
      roughness: 0.6,
      metallic: 0,
      ior: 1.5,
      specular: 0.5,
      clearcoat: 0,
      clearcoatRoughness: 0.05,
      sheen: 0,
      transmission: 0,
      thicknessMm: 0,
      emissiveStrength: 0,
    },
    maps,
    mapping: { three: {}, cycles: {} },
  },
});

const spec = (assignment: Record<string, unknown>, maps: Record<string, unknown>): RenderSpec =>
  ({
    specVersion: 1,
    document: {
      schemaVersion: 1,
      units: 'mm',
      product: { packKey: 'p', packVersion: '1.0.0', productKey: 'x', variantKey: 'y' },
      materials: { body: { materialKey: 'board-linen', textureScale: 1, textureRotationDeg: 0, ...assignment } },
      placements: [],
      scene: {
        environmentKey: 'studio-softbox',
        environmentRotationDeg: 0,
        exposureEv: 0,
        background: { kind: 'studio' },
        camera: { kind: 'preset', presetKey: 'front' },
      },
      annotations: {},
    },
    resolved: {
      meshKey: 'mesh.glb',
      meshDigest: '0'.repeat(64),
      bboxMm: [
        [-19, 0, -19],
        [19, 18, 19],
      ],
      zones: [],
      artwork: [],
      materials: [material(maps)],
      environment: { key: 'studio-softbox', hdriKey: 'builtin:studio-softbox', rotationDeg: 0, exposureEv: 0 },
    },
    outputs: [
      {
        kind: 'image',
        widthPx: 64,
        heightPx: 64,
        format: 'png16',
        alpha: false,
        camera: {
          kind: 'custom',
          positionMm: [0, 60, 90],
          targetMm: [0, 9, 0],
          upMm: [0, 1, 0],
          focalMm: 85,
          sensorMm: 36,
        },
      },
    ],
    quality: { preset: 'draft', samples: 16, denoiser: 'none', maxBounces: 4, adaptiveThreshold: 0.01, displacement: { mode: 'bump', dicingRate: 1 } },
    limits: { maxWallClockSec: 60 },
    renderer: { id: 'cycles', version: 'test' },
    seed: 1,
  }) as unknown as RenderSpec;

const build = (assignment: Record<string, unknown>, maps: Record<string, unknown>, texturePaths?: Record<string, string>) =>
  buildSceneJob({
    spec: spec(assignment, maps),
    meshPath: '/tmp/mesh.glb',
    baked: [],
    bakedDir: '/tmp/baked',
    outputDir: '/tmp/out',
    denoiserAvailable: false,
    bboxMm: [
      [-19, 0, -19],
      [19, 18, 19],
    ],
    ...(texturePaths ? { texturePaths } : {}),
  }).data as unknown as {
    materials: Record<string, { textures: { tilingMm: number; rotationDeg: number; baseColor: string | null; normal: string | null } | null }>;
  };

describe('material textures in the scene', () => {
  const maps = {
    baseColor: { path: 'packs/p/1.0.0/textures/linen.png', colorSpace: 'srgb' },
    normal: { path: 'packs/p/1.0.0/textures/linen-n.png', colorSpace: 'linear' },
    tilingMm: 40,
  };
  const fetched = {
    'packs/p/1.0.0/textures/linen.png': '/scratch/textures/linen.png',
    'packs/p/1.0.0/textures/linen-n.png': '/scratch/textures/linen-n.png',
  };

  it('hands the renderer local paths, not storage keys', () => {
    const data = build({}, maps, fetched);

    expect(data.materials['body']?.textures).toMatchObject({
      baseColor: '/scratch/textures/linen.png',
      normal: '/scratch/textures/linen-n.png',
    });
  });

  it('tiles by millimetres of product, scaled by the design', () => {
    expect(build({}, maps, fetched).materials['body']?.textures?.tilingMm).toBe(40);
    // Twice the scale means each tile covers twice the distance, so half as many tiles.
    expect(build({ textureScale: 2 }, maps, fetched).materials['body']?.textures?.tilingMm).toBe(80);
  });

  it('carries the rotation the design asked for', () => {
    expect(build({ textureRotationDeg: 45 }, maps, fetched).materials['body']?.textures?.rotationDeg).toBe(45);
  });

  it('renders from the numbers when a texture could not be fetched', () => {
    // No paths: the material is still a material, and a plain product beats a failed render.
    expect(build({}, maps).materials['body']?.textures).toBeNull();
  });

  it('says nothing about textures for a material that has none', () => {
    expect(build({}, { tilingMm: 50 }, fetched).materials['body']?.textures).toBeNull();
  });
});
