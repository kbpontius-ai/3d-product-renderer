import type { DecorationZoneDef } from './zone.js';

type ZoneOf<T extends DecorationZoneDef['type']> = Extract<DecorationZoneDef, { type: T }>;
import type { DesignDocument, Placement } from './design.js';
import { CURRENT_SCHEMA_VERSION } from './design.js';

/** Deterministic ids so fixtures produce stable snapshots and spec hashes. */
export const FIXTURE_IDS = {
  artwork: '11111111-1111-4111-8111-111111111111',
  artworkVersion: '22222222-2222-4222-8222-222222222222',
  placement: '33333333-3333-4333-8333-333333333333',
} as const;

/** Flat top face of a 38 mm closure. */
export const planarZoneFixture: ZoneOf<'planar'> = {
  type: 'planar',
  key: 'top',
  name: 'Top face',
  frame: { originMm: [0, 18, 0], normal: [0, 1, 0], tangent: [1, 0, 0] },
  sizeMm: { width: 30, height: 30, safeMarginMm: 1.5 },
  constraints: {
    finishes: ['emboss', 'deboss', 'print'],
    maxDepthMm: 0.6,
    minStrokeMm: 0.25,
    maxCoverage: 0.9,
    wrapWarnDeg: 120,
  },
};

/** Skirt of the same closure: a 38 mm diameter cylinder, 12 mm tall. */
export const cylindricalZoneFixture: ZoneOf<'cylindrical'> = {
  type: 'cylindrical',
  key: 'skirt',
  name: 'Skirt',
  frame: {
    axisOriginMm: [0, 0, 0],
    axisDir: [0, 1, 0],
    radiusMm: 19,
    centerAngleDeg: 0,
    centerHeightMm: 8,
  },
  sizeMm: { arcWidthMm: 40, height: 10, safeMarginMm: 1 },
  constraints: {
    finishes: ['emboss', 'deboss', 'print'],
    maxDepthMm: 0.4,
    minStrokeMm: 0.3,
    maxCoverage: 0.8,
    wrapWarnDeg: 120,
  },
};

export function placementFixture(overrides: Partial<Placement> = {}): Placement {
  return {
    id: FIXTURE_IDS.placement,
    zoneKey: 'top',
    artwork: { artworkId: FIXTURE_IDS.artwork, versionId: FIXTURE_IDS.artworkVersion },
    transform: {
      offsetMm: { x: 0, y: 0 },
      sizeMm: { w: 20, h: 8 },
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      lockAspect: true,
    },
    finish: { kind: 'deboss', depthMm: 0.35, bevelDeg: 30, edgeRadiusMm: 0.05 },
    order: 0,
    ...overrides,
  };
}

export function designFixture(overrides: Partial<DesignDocument> = {}): DesignDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    units: 'mm',
    product: {
      packKey: 'cap-basic',
      packVersion: '1.0.0',
      productKey: 'cap-38-flat',
      variantKey: '38mm',
    },
    materials: {
      body: { materialKey: 'pp-matte', colorHex: '#1b4d3e', textureScale: 1, textureRotationDeg: 0 },
    },
    placements: [placementFixture()],
    scene: {
      environmentKey: 'studio-softbox',
      environmentRotationDeg: 0,
      exposureEv: 0,
      background: { kind: 'studio' },
      camera: { kind: 'preset', presetKey: 'three-quarter' },
    },
    annotations: {},
    ...overrides,
  };
}
