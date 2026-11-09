import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validatePack,
  type ArtworkStats,
  type DecorationZoneDef,
  type Finish,
  type PackManifest,
  type Placement,
} from '@pr/design-schema';
import { mapperFor, type MeshSampler } from './mappers.js';
import { applySnap } from './snap.js';
import { aabb, clampToZone, initialTransform, isInsideSafeArea, isInsideZone } from './transform.js';
import { validatePlacement } from './validate.js';

/**
 * The conformance gate (F-GEN-09), run by `pnpm test` and therefore by CI on every push.
 *
 * Every placement behaviour is exercised against a small curved closure, a large flat carton AND an
 * oval bottle. A feature that only works on one of them has product-specific logic in it, which is
 * the one thing this codebase is not allowed to contain.
 *
 * The bottle is the third pack for a specific reason: the closure and the carton are both
 * *developable* — a plane and a cylinder unroll flat without distortion — so between them they
 * could not tell a correct mapping from one that merely projects. The bottle's flank curves in two
 * directions at once and carries the only `conformal` zone in the repository.
 */

const PACKS = ['cap-basic', 'bottle-oval', 'box-basic'] as const;

function loadPack(key: (typeof PACKS)[number]): PackManifest {
  const path = fileURLToPath(new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url));
  return validatePack(JSON.parse(readFileSync(path, 'utf8'))).manifest;
}

/** Stand-in for real geometry: UV-space zones only need *a* surface to answer with. */
const stubMesh: MeshSampler = {
  sampleByUv: (uv) => ({ position: [uv.x, uv.y, 0], normal: [0, 0, 1], tangent: [1, 0, 0] }),
  uvMetricAt: () => 1,
};

const artwork: ArtworkStats = {
  pathCount: 8,
  nodeCount: 220,
  naturalSizeMm: { w: 40, h: 16 },
  contentBbox: { x: 0, y: 0, w: 40, h: 16 },
  minStrokeMm: 1,
  coverage: 0.3,
  hasText: false,
  hasGradients: false,
  hasClipPaths: false,
};

function finishFor(zone: DecorationZoneDef): Finish {
  const allowed = zone.constraints.finishes;
  if (allowed.includes('deboss')) {
    return {
      kind: 'deboss',
      depthMm: Math.min(0.3, zone.constraints.maxDepthMm),
      bevelDeg: 30,
      edgeRadiusMm: 0.05,
    };
  }
  return { kind: 'print', inkMaterialKey: 'ink-test', opacity: 1 };
}

function placementFor(zone: DecorationZoneDef): Placement {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    zoneKey: zone.key,
    artwork: {
      artworkId: '11111111-1111-4111-8111-111111111111',
      versionId: '22222222-2222-4222-8222-222222222222',
    },
    transform: initialTransform(artwork.naturalSizeMm, extentOf(zone)),
    finish: finishFor(zone),
    order: 0,
  };
}

const extentOf = (zone: DecorationZoneDef) =>
  zone.type === 'cylindrical'
    ? { w: zone.sizeMm.arcWidthMm, h: zone.sizeMm.height, safeMarginMm: zone.sizeMm.safeMarginMm }
    : { w: zone.sizeMm.width, h: zone.sizeMm.height, safeMarginMm: zone.sizeMm.safeMarginMm };

const allZones = (m: PackManifest): { label: string; zone: DecorationZoneDef }[] =>
  m.products.flatMap((p) =>
    p.variants.flatMap((v) => v.zones.map((zone) => ({ label: `${p.key}/${v.key}/${zone.key}`, zone }))),
  );

describe.each(PACKS)('placement conformance on %s', (packKey) => {
  const manifest = loadPack(packKey);
  const zones = allZones(manifest);

  it('declares at least one decoration zone', () => {
    expect(zones.length).toBeGreaterThan(0);
  });

  describe.each(zones)('zone $label', ({ zone }) => {
    const extent = extentOf(zone);
    const mapper = mapperFor(zone, stubMesh);

    it('maps to a usable zone space', () => {
      expect(mapper.extent().w).toBeGreaterThan(0);
      expect(mapper.extent().h).toBeGreaterThan(0);
      expect(mapper.metric({ x: 0, y: 0 })).toBeGreaterThan(0);
    });

    it('produces a surface point at the zone centre', () => {
      const s = mapper.toWorld({ x: 0, y: 0 });
      expect(s.position.every(Number.isFinite)).toBe(true);
      expect(s.normal.every(Number.isFinite)).toBe(true);
    });

    it('keeps uv coordinates inside the unit square when it has any', () => {
      const uv = mapper.toUv({ x: extent.w / 2, y: extent.h / 2 });
      if (uv) {
        expect(uv.x).toBeGreaterThanOrEqual(0);
        expect(uv.x).toBeLessThanOrEqual(1);
        expect(uv.y).toBeGreaterThanOrEqual(0);
        expect(uv.y).toBeLessThanOrEqual(1);
      }
    });

    it('drops artwork centred inside the safe area', () => {
      const t = initialTransform(artwork.naturalSizeMm, extent);
      expect(t.offsetMm).toEqual({ x: 0, y: 0 });
      expect(isInsideSafeArea(t, extent)).toBe(true);
    });

    it('snaps a nudged placement back to the zone centre', () => {
      const t = initialTransform(artwork.naturalSizeMm, extent);
      const nudged = { ...t, offsetMm: { x: 0.3, y: 0.2 } };
      const snapped = applySnap(nudged, { zone: extent, pxPerMm: 10, enabled: true });
      expect(snapped.transform.offsetMm.x).toBeCloseTo(0, 6);
      expect(snapped.transform.offsetMm.y).toBeCloseTo(0, 6);
      expect(snapped.guides.map((g) => g.kind)).toContain('zoneCenter');
    });

    it('honours the snap override on every zone type', () => {
      const t = initialTransform(artwork.naturalSizeMm, extent);
      const nudged = { ...t, offsetMm: { x: 0.3, y: 0.2 } };
      const free = applySnap(nudged, { zone: extent, pxPerMm: 10, enabled: true }, { suspend: true });
      expect(free.transform.offsetMm).toEqual({ x: 0.3, y: 0.2 });
    });

    it('clamps a placement dragged off the edge', () => {
      const t = initialTransform(artwork.naturalSizeMm, extent);
      const pushed = { ...t, offsetMm: { x: extent.w, y: extent.h } };
      const clamped = clampToZone(pushed, extent);
      expect(clamped.hitBoundary).toBe(true);
      expect(isInsideZone(clamped.transform, extent)).toBe(true);
      expect(aabb(clamped.transform).max.x).toBeLessThanOrEqual(extent.w / 2 + 1e-6);
    });

    it('validates cleanly with the zone’s own default finish', () => {
      expect(validatePlacement(placementFor(zone), zone, artwork)).toEqual([]);
    });

    it('rejects a finish the zone does not offer', () => {
      const unsupported = (['emboss', 'deboss', 'print'] as const).find(
        (f) => !zone.constraints.finishes.includes(f),
      );
      if (!unsupported) return; // this zone offers everything
      const p = placementFor(zone);
      const finish: Finish =
        unsupported === 'print'
          ? { kind: 'print', inkMaterialKey: 'ink-test', opacity: 1 }
          : { kind: unsupported, depthMm: 0.2, bevelDeg: 30, edgeRadiusMm: 0.05 };
      const issues = validatePlacement({ ...p, finish }, zone, artwork);
      expect(issues.map((i) => i.code)).toContain('finish_not_allowed');
    });

    it('rejects relief deeper than the zone allows', () => {
      if (!zone.constraints.finishes.some((f) => f !== 'print')) return;
      const p = placementFor(zone);
      const issues = validatePlacement(
        {
          ...p,
          finish: {
            kind: 'deboss',
            depthMm: zone.constraints.maxDepthMm + 0.5,
            bevelDeg: 30,
            edgeRadiusMm: 0.05,
          },
        },
        zone,
        artwork,
      );
      expect(issues.map((i) => i.code)).toContain('depth_exceeds_max');
    });
  });
});
