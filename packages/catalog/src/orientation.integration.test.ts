import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  withTenant,
  type TestDatabase,
} from '@pr/db';
import type { PackManifest } from '@pr/design-schema';
import { importPack } from './import.js';
import { getPackAuthoring } from './zones.js';
import { updateProductSetup } from './orientation.js';
import { setPackStatus } from './packs.js';
import { createMaterial } from './materials.js';
import { getDesignProduct } from './query.js';

const frame = {
  version: 1 as const,
  frontSource: [0, 1, 0] as [number, number, number],
  upSource: [0, 0, -1] as [number, number, number],
  confirmed: true,
};

describe.skipIf(!hasDatabase)('product setup persistence', () => {
  let db: TestDatabase;
  let orgId: string;
  const source = () =>
    JSON.parse(
      readFileSync(
        new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as PackManifest;
  beforeAll(async () => {
    db = await createTestDatabase('pr_orientation');
    orgId = (await seedOrganizations(db.sql)).alpha;
  });
  afterAll(async () => {
    await db?.drop();
  });
  const draft = async (key: string) => {
    const manifest = source();
    manifest.key = key;
    manifest.products[0]!.variants[0]!.presentationOrientation = { ...frame, confirmed: false };
    return (await importPack(db.sql, manifest)).packId;
  };
  const patch = async (id: string, orientation = frame) => {
    const pack = await getPackAuthoring(db.sql, id);
    const variant = pack.variants[0]!;
    return updateProductSetup(
      db.sql,
      {
        packId: id,
        productKey: variant.productKey,
        variantKey: variant.variantKey,
        revision: pack.revision,
        orientation,
      },
      null,
    );
  };

  it('requires explicit confirmation before publishing a new oriented variant', async () => {
    const id = await draft('orientation-confirmation');
    await expect(setPackStatus(db.sql, id, 'published', null)).rejects.toThrow(
      'Confirm orientation',
    );
    await patch(id);
    await expect(setPackStatus(db.sql, id, 'published', null)).resolves.toHaveProperty(
      'status',
      'published',
    );
  });
  it('persists the frame without changing zone coordinates, bounds or asset references', async () => {
    const id = await draft('orientation-physical');
    const before = await withStaff(
      db.sql,
      async (tx) =>
        (await tx`select manifest from product_packs where id=${id}`)[0]![
          'manifest'
        ] as PackManifest,
    );
    await patch(id);
    const after = await withStaff(
      db.sql,
      async (tx) =>
        (await tx`select manifest from product_packs where id=${id}`)[0]![
          'manifest'
        ] as PackManifest,
    );
    const a = before.products[0]!.variants[0]!;
    const b = after.products[0]!.variants[0]!;
    expect(b.zones).toEqual(a.zones);
    expect(b.assets).toEqual(a.assets);
    expect(b.dimensionsMm).toEqual(a.dimensionsMm);
    expect(b.presentationOrientation).toEqual(frame);
    await setPackStatus(db.sql, id, 'published', null);
    const product = await getDesignProduct(
      db.sql,
      { orgId, userId: null },
      { packKey: after.key, packVersion: after.version, productKey: after.products[0]!.key },
    );
    expect(product?.variants[0]?.presentationOrientation).toEqual(frame);
    await expect(patch(id)).rejects.toThrow('new draft');
  });
  it('rejects a stale draft revision instead of overwriting another change', async () => {
    const id = await draft('orientation-stale');
    const before = await getPackAuthoring(db.sql, id);
    const v = before.variants[0]!;
    await patch(id);
    await expect(
      updateProductSetup(
        db.sql,
        {
          packId: id,
          productKey: v.productKey,
          variantKey: v.variantKey,
          revision: before.revision,
          orientation: frame,
        },
        null,
      ),
    ).rejects.toThrow('another window');
  });
  it('updates compatible slot defaults in both manifest and derived catalog rows', async () => {
    const id = await draft('orientation-materials');
    const definition = source().materials.find((m) => m.key === 'pp-matte')!;
    await createMaterial(
      db.sql,
      {
        key: 'orientation-resin',
        name: 'Orientation resin',
        family: 'plastic',
        definition,
        status: 'published',
      },
      null,
    );
    const pack = await getPackAuthoring(db.sql, id);
    const variant = pack.variants[0]!;
    await updateProductSetup(
      db.sql,
      {
        packId: id,
        productKey: variant.productKey,
        variantKey: variant.variantKey,
        revision: pack.revision,
        materialDefaults: { body: 'orientation-resin' },
      },
      null,
    );
    const saved = await getPackAuthoring(db.sql, id);
    expect(saved.variants[0]!.materialSlots.find((s) => s.key === 'body')?.defaultMaterialKey).toBe(
      'orientation-resin',
    );
    const rows = await withStaff(
      db.sql,
      (tx) => tx`select material_slots from product_variants where id=${variant.variantId}`,
    );
    expect(rows[0]!['material_slots']).toEqual(saved.variants[0]!.materialSlots);
    const manifest = await withStaff(
      db.sql,
      async (tx) =>
        (await tx`select manifest from product_packs where id=${id}`)[0]![
          'manifest'
        ] as PackManifest,
    );
    expect(manifest.materials.some((m) => m.key === 'orientation-resin')).toBe(true);
    await expect(
      updateProductSetup(
        db.sql,
        {
          packId: id,
          productKey: variant.productKey,
          variantKey: variant.variantKey,
          revision: saved.revision,
          materialDefaults: { body: 'missing-material' },
        },
        null,
      ),
    ).rejects.toThrow('existing material');
    expect((await getPackAuthoring(db.sql, id)).revision).toBe(saved.revision);
  });

  it('keeps legacy manifests publishable without an inferred orientation', async () => {
    const manifest = source();
    manifest.key = 'orientation-legacy';
    const id = (await importPack(db.sql, manifest)).packId;
    await setPackStatus(db.sql, id, 'published', null);
    expect(
      (await getPackAuthoring(db.sql, id)).variants[0]?.presentationOrientation,
    ).toBeUndefined();
  });
  it('does not expose product setup to a tenant query', async () => {
    const id = await draft('orientation-access');
    const rows = await withTenant(
      db.sql,
      { orgId, userId: null },
      (tx) => tx`update product_packs set manifest = '{}'::jsonb where id=${id} returning id`,
    );
    expect(rows).toHaveLength(0);
    expect((await getPackAuthoring(db.sql, id)).variants).toHaveLength(1);
  });
});
