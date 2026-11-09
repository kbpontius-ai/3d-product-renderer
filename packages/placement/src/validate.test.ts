import { describe, expect, it } from 'vitest';
import type { ArtworkStats, DecorationZoneDef, Placement } from '@pr/design-schema';
import {
  cylindricalZoneFixture,
  designFixture,
  placementFixture,
  planarZoneFixture,
} from '@pr/design-schema/fixtures';
import {
  isRenderable,
  validateDesign,
  validatePlacement,
  type DesignValidationContext,
} from './validate.js';

const stats = (over: Partial<ArtworkStats> = {}): ArtworkStats => ({
  pathCount: 12,
  nodeCount: 340,
  naturalSizeMm: { w: 40, h: 16 },
  contentBbox: { x: 0, y: 0, w: 40, h: 16 },
  minStrokeMm: 1,
  coverage: 0.3,
  hasText: false,
  hasGradients: false,
  hasClipPaths: false,
  ...over,
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('validatePlacement', () => {
  it('accepts a well-formed placement', () => {
    expect(validatePlacement(placementFixture(), planarZoneFixture, stats())).toEqual([]);
  });

  it('errors when artwork extends past the decoration area', () => {
    const p = placementFixture({
      transform: { ...placementFixture().transform, sizeMm: { w: 40, h: 16 } },
    });
    expect(codes(validatePlacement(p, planarZoneFixture, stats()))).toContain(
      'placement_outside_zone',
    );
  });

  it('warns when artwork enters the safe margin', () => {
    const base = placementFixture();
    const p = placementFixture({
      transform: { ...base.transform, sizeMm: { w: 28, h: 11.2 }, offsetMm: { x: 0, y: 0 } },
    });
    expect(codes(validatePlacement(p, planarZoneFixture, stats()))).toContain('outside_safe_margin');
  });

  it('errors when the relief is deeper than the zone allows', () => {
    const p = placementFixture({
      finish: { kind: 'deboss', depthMm: 1.2, bevelDeg: 30, edgeRadiusMm: 0.05 },
    });
    const issues = validatePlacement(p, planarZoneFixture, stats());
    expect(codes(issues)).toContain('depth_exceeds_max');
    expect(issues[0]?.detail).toMatchObject({ max: 0.6 });
  });

  it('errors when the finish is not offered by the zone', () => {
    const printOnly: DecorationZoneDef = {
      ...planarZoneFixture,
      constraints: { ...planarZoneFixture.constraints, finishes: ['print'] },
    };
    const p = placementFixture({
      finish: { kind: 'emboss', depthMm: 0.3, bevelDeg: 30, edgeRadiusMm: 0.05 },
    });
    expect(codes(validatePlacement(p, printOnly, stats()))).toContain('finish_not_allowed');
  });

  it('warns about strokes that are too thin once scaled down', () => {
    // 0.6 mm stroke on 40 mm artwork placed at 20 mm wide => 0.3 mm... still fine.
    const fine = validatePlacement(placementFixture(), planarZoneFixture, stats({ minStrokeMm: 0.6 }));
    expect(codes(fine)).not.toContain('thin_strokes');

    // 0.4 mm stroke at half scale => 0.2 mm, below the zone's 0.25 mm limit.
    const thin = validatePlacement(placementFixture(), planarZoneFixture, stats({ minStrokeMm: 0.4 }));
    expect(codes(thin)).toContain('thin_strokes');
  });

  it('warns when artwork covers most of the area', () => {
    const p = placementFixture({
      transform: { ...placementFixture().transform, sizeMm: { w: 29, h: 29 } },
    });
    const issues = codes(validatePlacement(p, planarZoneFixture, stats({ coverage: 1 })));
    expect(issues).toContain('coverage_high');
    expect(issues).toContain('outside_safe_margin'); // 29 mm of a 30 mm zone eats the margin too
  });

  it('warns when artwork wraps too far around a cylinder', () => {
    const wide = {
      ...cylindricalZoneFixture,
      sizeMm: { arcWidthMm: 60, height: 10, safeMarginMm: 1 },
    } satisfies DecorationZoneDef;
    const p: Placement = placementFixture({
      zoneKey: 'skirt',
      transform: { ...placementFixture().transform, sizeMm: { w: 45, h: 6 } },
      finish: { kind: 'deboss', depthMm: 0.3, bevelDeg: 30, edgeRadiusMm: 0.05 },
    });
    const issues = validatePlacement(p, wide, stats());
    expect(codes(issues)).toContain('wrap_angle_high');
    expect(issues.find((i) => i.code === 'wrap_angle_high')?.detail?.['wrapDeg']).toBeGreaterThan(120);
  });

  it('errors when the artwork has not finished processing', () => {
    expect(codes(validatePlacement(placementFixture(), planarZoneFixture, undefined))).toContain(
      'artwork_unknown',
    );
  });
});

describe('validateDesign', () => {
  const ctx = (over: Partial<DesignValidationContext> = {}): DesignValidationContext => ({
    zones: { top: planarZoneFixture, skirt: cylindricalZoneFixture },
    materialSlots: { body: { allowedFamilies: ['plastic'], colorizable: true } },
    materials: { 'pp-matte': { family: 'plastic', colorizable: true } },
    artwork: { '22222222-2222-4222-8222-222222222222': stats() },
    ...over,
  });

  it('passes a valid design', () => {
    const result = validateDesign(designFixture(), ctx());
    expect(result.errors).toEqual([]);
    expect(isRenderable(result)).toBe(true);
  });

  it('errors on an unknown decoration area', () => {
    const doc = designFixture({ placements: [placementFixture({ zoneKey: 'nope' })] });
    expect(codes(validateDesign(doc, ctx()).errors)).toContain('zone_unknown');
  });

  it('errors on an unknown material slot', () => {
    const doc = designFixture({
      materials: { lid: { materialKey: 'pp-matte', textureScale: 1, textureRotationDeg: 0 } },
    });
    expect(codes(validateDesign(doc, ctx()).errors)).toContain('material_slot_unknown');
  });

  it('errors when a material family is not offered for the slot', () => {
    const result = validateDesign(
      designFixture({
        materials: { body: { materialKey: 'glass-clear', textureScale: 1, textureRotationDeg: 0 } },
      }),
      ctx({ materials: { 'glass-clear': { family: 'glass', colorizable: false } } }),
    );
    expect(codes(result.errors)).toContain('material_family_not_allowed');
  });

  it('warns when colour is set on a material that ignores it', () => {
    const result = validateDesign(
      designFixture(),
      ctx({ materials: { 'pp-matte': { family: 'plastic', colorizable: false } } }),
    );
    expect(codes(result.warnings)).toContain('material_not_colorizable');
  });

  it('separates blocking errors from advisory warnings', () => {
    const doc = designFixture({
      placements: [
        placementFixture({
          finish: { kind: 'deboss', depthMm: 2, bevelDeg: 30, edgeRadiusMm: 0.05 },
        }),
      ],
    });
    const result = validateDesign(doc, ctx({ artwork: { '22222222-2222-4222-8222-222222222222': stats({ minStrokeMm: 0.2 }) } }));
    expect(codes(result.errors)).toContain('depth_exceeds_max');
    expect(codes(result.warnings)).toContain('thin_strokes');
    expect(isRenderable(result)).toBe(false);
  });
});
