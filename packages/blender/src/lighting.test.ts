import { describe, expect, it } from 'vitest';
import { RenderLighting, RenderSpec } from '@pr/design-schema';
import { designFixture, planarZoneFixture } from '@pr/design-schema/fixtures';
import { environmentFor, frameFromDirections, placeLights, subjectFromBbox } from '@pr/scene';
import { buildSceneJob } from './scene.js';

const bbox: RenderSpec['resolved']['bboxMm'] = [[10, 20, 30], [50, 40, 70]];
const productFrame = frameFromDirections([0, 0, 1], [0, 1, 0]);
const inspectionFrame = frameFromDirections([0, 1, 0], [1, 0, 0]);

function spec(): RenderSpec {
  const document = designFixture({ placements: [] });
  return RenderSpec.parse({
    specVersion: 1,
    document,
    resolved: {
      meshKey: 'mesh.glb', meshDigest: 'a'.repeat(64), bboxMm: bbox,
      presentationOrientation: productFrame,
      zones: [planarZoneFixture], artwork: [], materials: [],
      environment: { key: 'studio-softbox', hdriKey: 'builtin:studio-softbox', rotationDeg: 0, exposureEv: 0 },
    },
    outputs: [{ kind: 'image', widthPx: 256, heightPx: 256, format: 'png8',
      camera: { kind: 'custom', positionMm: [30, 130, 100], targetMm: [30, 30, 50], upMm: [0, 1, 0], focalMm: 85, sensorMm: 36 } }],
    quality: { preset: 'draft', samples: 16, maxBounces: 4, denoiser: 'none', adaptiveThreshold: 0.05, displacement: { mode: 'bump' } },
    renderer: { id: 'cycles', version: 'test' }, seed: 7, limits: { maxWallClockSec: 60, maxVramMb: 1024 },
  });
}
function scene(input: RenderSpec) {
  return buildSceneJob({ spec: input, meshPath: 'mesh.glb', baked: [], bakedDir: '.', outputDir: '.', denoiserAvailable: false, bboxMm: bbox }).data;
}

describe('render lighting snapshot', () => {
  it('uses captured Inspection lighting and orientation without rotating the saved design', () => {
    const input = spec();
    const original = structuredClone(input.document);
    const before = scene(input);
    input.resolved.environment = { key: 'studio-detail-v1', hdriKey: 'builtin:studio-detail-v1', rotationDeg: 37, exposureEv: 0, orientation: inspectionFrame };
    const data = scene(input);
    const expected = placeLights(environmentFor('studio-detail-v1'), subjectFromBbox(bbox), 37, inspectionFrame);
    expect(data.world.lights).toHaveLength(expected.length);
    for (const [i, light] of expected.entries()) {
      expect(data.world.lights[i]).toMatchObject({ positionMm: light.positionMm, targetMm: light.targetMm, energyW: light.energyW, sizeMm: light.sizeMm });
    }
    expect(data.world.upSource).toEqual(inspectionFrame.upSource);
    expect(data.world.background).toEqual(environmentFor('studio-detail-v1').world);
    expect(input.document).toEqual(original);
    expect(data.outputs).toEqual(before.outputs);
    expect(data.materials).toEqual(before.materials);
  });

  it('keeps the legacy presentation frame when no lighting orientation is supplied', () => {
    const data = scene(spec());
    expect(data.world.upSource).toEqual(productFrame.upSource);
    expect(data.world.lights[0]?.positionMm).toEqual(placeLights(environmentFor('studio-softbox'), subjectFromBbox(bbox), 0, productFrame)[0]?.positionMm);
  });

  it('rejects invalid rotations, malformed axes and arbitrary light payloads', () => {
    for (const rotationDeg of [NaN, Infinity, 361]) {
      expect(RenderLighting.safeParse({ environmentKey: 'studio-detail-v1', rotationDeg }).success).toBe(false);
    }
    expect(RenderLighting.safeParse({ environmentKey: 'studio-detail-v1', rotationDeg: 0, orientation: { ...inspectionFrame, upSource: inspectionFrame.frontSource } }).success).toBe(false);
    expect(RenderLighting.safeParse({ environmentKey: 'studio-detail-v1', rotationDeg: 0, lights: [] }).success).toBe(false);
  });
});
