import { describe, expect, it } from 'vitest';
import type { RenderSpec } from '@pr/design-schema';
import { designFixture, placementFixture } from '@pr/design-schema/fixtures';
import { canonicalJson, NonCanonicalValueError } from './canonical.js';
import { specHash } from './hash.js';
import { buildRenderSpec, DEFAULT_LIMITS, type BuildRenderSpecInput } from './build.js';
import { describeDuration, estimateRender, REFERENCE_COST_MODEL } from './estimate.js';

const DIGEST = 'a'.repeat(64);

const resolved: RenderSpec['resolved'] = {
  meshKey: 'packs/cap-basic/1.0.0/meshes/cap-flat/38mm/render.glb',
  meshDigest: DIGEST,
  bboxMm: [
    [-19, 0, -19],
    [19, 18, 19],
  ],
  zones: [],
  artwork: [
    {
      versionId: '22222222-2222-4222-8222-222222222222',
      maskKey: 'artwork/o/a/v/mask.png',
      sdfKey: 'artwork/o/a/v/sdf.png',
      sdfRangeMm: [-2, 3],
      mmPerPx: 0.012,
      digest: DIGEST,
    },
  ],
  materials: [],
  environment: {
    key: 'studio-softbox',
    hdriKey: 'env/studio-softbox/softbox.hdr',
    rotationDeg: 0,
    exposureEv: 0,
  },
};

const input = (over: Partial<BuildRenderSpecInput> = {}): BuildRenderSpecInput => ({
  document: designFixture(),
  resolved,
  outputs: [
    {
      kind: 'image',
      widthPx: 2048,
      heightPx: 2048,
      format: 'png16',
      camera: { kind: 'preset', presetKey: 'three-quarter' },
    },
  ],
  preset: 'final',
  renderer: { id: 'cycles', version: '4.2.1' },
  seed: 7,
  ...over,
});

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('treats an absent key and an undefined key as the same', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('collapses negative zero', () => {
    expect(canonicalJson({ x: -0 })).toBe(canonicalJson({ x: 0 }));
  });

  it('refuses values that cannot round-trip', () => {
    expect(() => canonicalJson({ x: NaN })).toThrow(NonCanonicalValueError);
    expect(() => canonicalJson({ x: Infinity })).toThrow(NonCanonicalValueError);
  });
});

describe('buildRenderSpec', () => {
  it('captures orientation in immutable job identity without changing absent legacy fields', () => {
    const frame = {
      version: 1 as const,
      frontSource: [0, 1, 0] as [number, number, number],
      upSource: [0, 0, -1] as [number, number, number],
    };
    const document = designFixture();
    document.scene.presentationOrientationOverride = frame;
    const spec = buildRenderSpec(input({ document }));
    expect(spec.resolved.presentationOrientation).toEqual(frame);
    const legacy = buildRenderSpec(input());
    expect(legacy.resolved.presentationOrientation).toBeUndefined();
    expect(specHash(spec)).not.toBe(specHash(legacy));
    expect(
      specHash(
        buildRenderSpec(input({ resolved: { ...resolved, presentationOrientation: undefined } })),
      ),
    ).toBe(specHash(legacy));
  });

  it('includes viewer lighting in job identity without changing the saved document', () => {
    const legacy = buildRenderSpec(input());
    const orientation = { version: 1 as const, frontSource: [0, 1, 0] as [number, number, number], upSource: [1, 0, 0] as [number, number, number] };
    const inspection = buildRenderSpec(input({ resolved: { ...resolved, environment: {
      ...resolved.environment, key: 'studio-detail-v1', hdriKey: 'builtin:studio-detail-v1', orientation,
    } } }));
    expect(inspection.document).toEqual(legacy.document);
    expect(specHash(inspection)).not.toBe(specHash(legacy));
    const rotated = structuredClone(inspection);
    rotated.resolved.environment.rotationDeg = 45;
    expect(specHash(rotated)).not.toBe(specHash(inspection));
    expect(specHash(JSON.parse(JSON.stringify(inspection)) as RenderSpec)).toBe(specHash(inspection));
    expect(legacy.resolved.environment).not.toHaveProperty('orientation');
  });

  it('applies the quality preset', () => {
    const spec = buildRenderSpec(input({ preset: 'draft' }));
    expect(spec.quality.samples).toBe(64);
    expect(spec.quality.displacement.mode).toBe('bump'); // draft falls back to bump
    expect(buildRenderSpec(input({ preset: 'final' })).quality.displacement.mode).toBe(
      'displacement',
    );
  });

  it('applies default limits and lets callers tighten them', () => {
    expect(buildRenderSpec(input()).limits).toEqual(DEFAULT_LIMITS);
    expect(
      buildRenderSpec(input({ limits: { maxWallClockSec: 300 } })).limits.maxWallClockSec,
    ).toBe(300);
  });

  it('fills video defaults including the shared orbit path', () => {
    const spec = buildRenderSpec(
      input({ outputs: [{ kind: 'video', widthPx: 1080, heightPx: 1080 }] }),
    );
    const output = spec.outputs[0]!;
    expect(output.kind).toBe('video');
    if (output.kind === 'video') {
      expect(output.fps).toBe(30);
      expect(output.durationSec).toBe(8);
      expect(output.orbit.radiusScale).toBe(2.6);
    }
  });

  it('rejects a malformed spec at build time rather than in a GPU worker', () => {
    expect(() =>
      buildRenderSpec(
        input({
          outputs: [
            {
              kind: 'image',
              widthPx: 99,
              heightPx: 2048,
              format: 'png16',
              camera: { kind: 'preset', presetKey: 'front' },
            },
          ],
        }),
      ),
    ).toThrow();
  });
});

describe('specHash', () => {
  it('is stable for identical inputs', () => {
    expect(specHash(buildRenderSpec(input()))).toBe(specHash(buildRenderSpec(input())));
  });

  it('changes when the design changes by a tenth of a millimetre', () => {
    const moved = designFixture({
      placements: [
        placementFixture({
          transform: { ...placementFixture().transform, offsetMm: { x: 0.1, y: 0 } },
        }),
      ],
    });
    expect(specHash(buildRenderSpec(input()))).not.toBe(
      specHash(buildRenderSpec(input({ document: moved }))),
    );
  });

  it('changes with quality, seed, renderer version and output size', () => {
    const base = specHash(buildRenderSpec(input()));
    expect(specHash(buildRenderSpec(input({ preset: 'draft' })))).not.toBe(base);
    expect(specHash(buildRenderSpec(input({ seed: 8 })))).not.toBe(base);
    expect(
      specHash(buildRenderSpec(input({ renderer: { id: 'cycles', version: '4.3.0' } }))),
    ).not.toBe(base);
    expect(
      specHash(
        buildRenderSpec(
          input({
            outputs: [
              {
                kind: 'image',
                widthPx: 4096,
                heightPx: 4096,
                format: 'png16',
                camera: { kind: 'preset', presetKey: 'three-quarter' },
              },
            ],
          }),
        ),
      ),
    ).not.toBe(base);
  });

  it('is a 64-character hex digest', () => {
    expect(specHash(buildRenderSpec(input()))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('estimateRender', () => {
  it('grows with resolution and sample count', () => {
    const standard = estimateRender(buildRenderSpec(input({ preset: 'standard' })));
    const final = estimateRender(buildRenderSpec(input({ preset: 'final' })));
    expect(final.seconds).toBeGreaterThan(standard.seconds);

    const big = estimateRender(
      buildRenderSpec(
        input({
          outputs: [
            {
              kind: 'image',
              widthPx: 4096,
              heightPx: 4096,
              format: 'png16',
              camera: { kind: 'preset', presetKey: 'front' },
            },
          ],
        }),
      ),
    );
    expect(big.seconds).toBeGreaterThan(final.seconds);
    expect(big.megapixels).toBeCloseTo(16.777, 2);
  });

  it('counts every video frame', () => {
    const est = estimateRender(
      buildRenderSpec(
        input({
          outputs: [{ kind: 'video', widthPx: 1080, heightPx: 1080, fps: 30, durationSec: 8 }],
        }),
      ),
    );
    expect(est.frames).toBe(240);
    expect(est.seconds).toBeGreaterThan(REFERENCE_COST_MODEL.fixedOverheadSec);
  });

  it('charges in whole cents, never zero for real work', () => {
    const est = estimateRender(buildRenderSpec(input()));
    expect(Number.isInteger(est.cents)).toBe(true);
    expect(est.cents).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const spec = buildRenderSpec(input());
    expect(estimateRender(spec)).toEqual(estimateRender(spec));
  });
});

describe('describeDuration', () => {
  it('speaks in seconds under a minute and a half', () => {
    expect(describeDuration(35)).toBe('about 40 seconds');
  });

  it('speaks in minutes above that', () => {
    expect(describeDuration(200)).toBe('about 3 minutes');
    expect(describeDuration(70 * 60)).toBe('about 70 minutes');
  });
});
