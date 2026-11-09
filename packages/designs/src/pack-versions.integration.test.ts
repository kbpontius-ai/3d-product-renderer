import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, hasDatabase, seedOrganizations, withStaff, type Sql, type TestDatabase } from '@pr/db';
import { getDesignProduct, importPack, listProducts, setPackStatus } from '@pr/catalog';
import type { PackManifest, Placement } from '@pr/design-schema';
import { createDesign, loadDesign, saveDesign } from './service.js';

/**
 * A pack with more than one version (F-ADM-13, found in the zone-authoring walkthrough).
 *
 * "Make a new draft version" turned publishing a second version from a rare import into the normal
 * way a zone gets fixed. Before this, the catalog merged the versions into one product with two
 * identical variants, and a design made on the old version was checked against the new version's
 * zones — so removing a zone in 0.2.0 stopped designs on 0.1.0 from saving.
 */

const loadPack = (): PackManifest =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url)), 'utf8'),
  ) as PackManifest;

const version = (v: string, options: { withoutSkirt?: boolean } = {}): PackManifest => {
  const manifest = loadPack();
  manifest.key = 'cap-versioned';
  manifest.version = v;
  if (options.withoutSkirt) {
    for (const product of manifest.products) {
      for (const variant of product.variants) variant.zones = variant.zones.filter((zone) => zone.key !== 'skirt');
    }
  }
  return manifest;
};

describe.skipIf(!hasDatabase)('pack versions', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  const alpha = () => ({ orgId: orgs.alpha, userId: null });

  const onSkirt: Placement = {
    id: '66666666-6666-4666-8666-666666666666',
    zoneKey: 'skirt',
    artwork: {
      artworkId: '11111111-1111-4111-8111-111111111111',
      versionId: '22222222-2222-4222-8222-222222222222',
    },
    transform: {
      offsetMm: { x: 0, y: 0 },
      sizeMm: { w: 10, h: 4 },
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      lockAspect: true,
    },
    finish: { kind: 'deboss', depthMm: 0.3, bevelDeg: 30, edgeRadiusMm: 0.05 },
    order: 0,
  };

  const status = async (v: string) =>
    withStaff(sql, async (tx) => {
      const [row] = await tx`select status from product_packs where key = 'cap-versioned' and version = ${v}`;
      return row?.['status'] as string | undefined;
    });

  let designId: string;
  let designVersion: number;

  beforeAll(async () => {
    db = await createTestDatabase('pr_versions');
    sql = db.sql;
    orgs = await seedOrganizations(sql);

    // 1.0.0 has a skirt zone, and a customer's design uses it.
    await importPack(sql, version('1.0.0'), { publish: true });
    const products = await listProducts(sql, alpha());
    const variantId = products.find((p) => p.packKey === 'cap-versioned')!.variants[0]!.variantId;
    const design = await createDesign(sql, alpha(), { variantId, name: 'Skirt logo' });
    const saved = await saveDesign(sql, alpha(), {
      designId: design.id,
      document: { ...design.document, placements: [onSkirt] },
      expectedVersion: design.version,
    });
    designId = design.id;
    designVersion = saved.version;

    // 1.1.0 drops the skirt, and is published over it.
    await importPack(sql, version('1.1.0', { withoutSkirt: true }), { publish: true });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('offers only one version of a pack in the catalog', async () => {
    const products = (await listProducts(sql, alpha())).filter((p) => p.packKey === 'cap-versioned');

    expect(products).toHaveLength(1);
    expect(products[0]!.packVersion).toBe('1.1.0');
    expect(products[0]!.variants).toHaveLength(1);
  });

  it('retires the version a newer one replaces', async () => {
    expect(await status('1.0.0')).toBe('deprecated');
    expect(await status('1.1.0')).toBe('published');
  });

  it('keeps checking a design against the version it was made on', async () => {
    // The skirt is gone from 1.1.0 but not from 1.0.0, which is what this design is built on.
    const design = await loadDesign(sql, alpha(), designId);
    const saved = await saveDesign(sql, alpha(), {
      designId,
      document: { ...design.document, placements: [{ ...onSkirt, transform: { ...onSkirt.transform, offsetMm: { x: 1, y: 0 } } }] },
      expectedVersion: designVersion,
    });
    expect(saved.version).toBe(designVersion + 1);
  });

  it('still finds a retired version for the designs made on it', async () => {
    const product = await getDesignProduct(sql, alpha(), {
      packKey: 'cap-versioned',
      packVersion: '1.0.0',
      productKey: 'cap-flat',
    });

    expect(product?.packVersion).toBe('1.0.0');
    expect(product?.variants[0]!.zones.map((zone) => zone.key)).toContain('skirt');
  });

  it('retires the older version when a draft is published from the Packs page too', async () => {
    const draft = await importPack(sql, version('1.2.0'));
    await setPackStatus(sql, draft.packId, 'published', null);

    expect(await status('1.1.0')).toBe('deprecated');
    expect(await status('1.2.0')).toBe('published');
  });

  it('never lets a tenant reach a draft, even by naming its exact version', async () => {
    // The policy now admits retired versions; it must not have admitted drafts along with them.
    await importPack(sql, version('9.0.0'));
    expect(
      await getDesignProduct(sql, alpha(), { packKey: 'cap-versioned', packVersion: '9.0.0', productKey: 'cap-flat' }),
    ).toBeNull();
  });
});
