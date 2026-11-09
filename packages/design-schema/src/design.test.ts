import { describe, expect, it } from 'vitest';
import { DesignDocument } from './design.js';
import { designFixture, placementFixture } from './fixtures.js';
import { migrateDesign, SchemaMigrationError } from './migrate.js';
import { zoneExtentMm } from './zone.js';
import { cylindricalZoneFixture, planarZoneFixture } from './fixtures.js';

describe('DesignDocument', () => {
  it('accepts the fixture document', () => {
    expect(() => DesignDocument.parse(designFixture())).not.toThrow();
  });

  it('rejects a relief finish deeper than the schema ceiling', () => {
    const doc = designFixture({
      placements: [
        placementFixture({ finish: { kind: 'emboss', depthMm: 9, bevelDeg: 30, edgeRadiusMm: 0 } }),
      ],
    });
    expect(() => DesignDocument.parse(doc)).toThrow();
  });

  it('rejects a print finish without an ink material', () => {
    const doc = designFixture({
      // @ts-expect-error deliberately invalid: exercising the runtime guard
      placements: [placementFixture({ finish: { kind: 'print', opacity: 1 } })],
    });
    expect(() => DesignDocument.parse(doc)).toThrow();
  });

  it('requires explicit millimetre units', () => {
    // @ts-expect-error units is a literal; this is what a corrupted document would look like
    expect(() => DesignDocument.parse(designFixture({ units: 'in' }))).toThrow();
  });

  it('round-trips through JSON without loss', () => {
    const doc = designFixture();
    expect(DesignDocument.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
});

describe('migrateDesign', () => {
  it('passes a current document straight through', () => {
    const doc = designFixture();
    expect(migrateDesign(doc)).toEqual(doc);
  });

  it('throws for an unknown future version rather than guessing', () => {
    expect(() => migrateDesign({ ...designFixture(), schemaVersion: 99 })).toThrow();
  });

  it('throws for a version with no migration path', () => {
    expect(() => migrateDesign({ schemaVersion: -1 })).toThrow(SchemaMigrationError);
  });
});

describe('zoneExtentMm', () => {
  it('normalises planar zones', () => {
    expect(zoneExtentMm(planarZoneFixture)).toEqual({ w: 30, h: 30, safeMarginMm: 1.5 });
  });

  it('normalises cylindrical zones to arc width', () => {
    expect(zoneExtentMm(cylindricalZoneFixture)).toEqual({ w: 40, h: 10, safeMarginMm: 1 });
  });
});
