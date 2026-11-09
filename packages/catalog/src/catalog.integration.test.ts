import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, hasDatabase, seedOrganizations, type Sql, type TestDatabase } from '@pr/db';
import { importPack, PackImportError, publishPack } from './import.js';
import { listProducts, summariseFacets } from './query.js';
import { listDesigns } from '@pr/designs';

/**
 * Pack import and catalog reads (F-GEN-02, W-15).
 *
 * Both fixture packs go through the same importer, and the reads are checked from an ordinary
 * tenant context — visibility is a policy, not a filter someone remembered to write.
 */

const loadPack = (key: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url)), 'utf8'),
  );

describe.skipIf(!hasDatabase)('catalog', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };

  beforeAll(async () => {
    db = await createTestDatabase('pr_catalog');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const tenant = (orgId: string) => ({ orgId, userId: null });

  describe('import', () => {
    it('imports both fixture packs — the genericity gate, applied to the database', async () => {
      const cap = await importPack(sql, loadPack('cap-basic'), { publish: true });
      const box = await importPack(sql, loadPack('box-basic'), { publish: true });

      expect(cap.status).toBe('created');
      expect(cap.products).toBe(1);
      expect(cap.zones).toBe(2);
      expect(box.status).toBe('created');
      expect(box.zones).toBe(2);
    });

    it('is idempotent: the same bytes import to nothing new', async () => {
      const again = await importPack(sql, loadPack('cap-basic'), { publish: true });
      expect(again.status).toBe('unchanged');
    });

    it('refuses to rewrite a published version with different contents', async () => {
      // A published version is what designs are built on. Changing it under the same number used to
      // go through as "replaced", silently, and moved zones out from under designs (W-15).
      const edited = loadPack('cap-basic') as { name: string };
      edited.name = 'Basic closures (revised)';

      await expect(importPack(sql, edited, { publish: true })).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'version_exists', path: 'cap-basic@1.0.0' })],
      });
    });

    it('replaces a published version only when asked to, explicitly', async () => {
      const edited = loadPack('cap-basic') as { name: string };
      edited.name = 'Basic closures (revised)';

      const result = await importPack(sql, edited, { publish: true, replace: true });
      expect(result.status).toBe('replaced');

      const products = await listProducts(sql, tenant(orgs.alpha));
      expect(products.some((p) => p.packKey === 'cap-basic')).toBe(true);
    });

    it('carries existing designs onto the rows that replace their variant', async () => {
      const { createDesign, loadDesign } = await import('@pr/designs');
      const products = await listProducts(sql, tenant(orgs.alpha));
      const variant = products.find((p) => p.productKey === 'cap-flat')!.variants[0]!;

      const design = await createDesign(sql, tenant(orgs.alpha), { variantId: variant.variantId });

      const edited = loadPack('cap-basic') as { name: string };
      edited.name = `Basic closures ${Date.now()}`;
      expect((await importPack(sql, edited, { publish: true, replace: true })).status).toBe('replaced');

      // The design still opens, and still knows which product it is for.
      const reopened = await loadDesign(sql, tenant(orgs.alpha), design.id);
      expect(reopened.document.product.productKey).toBe('cap-flat');
      expect((await listDesigns(sql, tenant(orgs.alpha))).map((d) => d.id)).toContain(design.id);
    });

    it('refuses to replace a version that would orphan a design', async () => {
      const { createDesign } = await import('@pr/designs');
      const products = await listProducts(sql, tenant(orgs.alpha));
      const variant = products.find((p) => p.productKey === 'cap-flat')!.variants[0]!;
      await createDesign(sql, tenant(orgs.alpha), { variantId: variant.variantId });

      const renamed = loadPack('cap-basic') as { products: { variants: { key: string }[] }[] };
      renamed.products[0]!.variants[0]!.key = 'renamed';

      await expect(importPack(sql, renamed, { publish: true, replace: true })).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'asset_missing' })]),
      });
    });

    it('never drops a zone a design places artwork in, even when replacing on purpose', async () => {
      const { createDesign, saveDesign } = await import('@pr/designs');
      const products = await listProducts(sql, tenant(orgs.alpha));
      const variant = products.find((p) => p.productKey === 'cap-flat')!.variants[0]!;
      const design = await createDesign(sql, tenant(orgs.alpha), { variantId: variant.variantId, name: 'Skirt logo' });
      await saveDesign(sql, tenant(orgs.alpha), {
        designId: design.id,
        expectedVersion: design.version,
        document: {
          ...design.document,
          placements: [
            {
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
            },
          ],
        },
      });

      const withoutSkirt = loadPack('cap-basic') as { products: { variants: { zones: { key: string }[] }[] }[] };
      for (const product of withoutSkirt.products) {
        for (const v of product.variants) v.zones = v.zones.filter((zone) => zone.key !== 'skirt');
      }

      await expect(importPack(sql, withoutSkirt, { publish: true, replace: true })).rejects.toMatchObject({
        message: expect.stringContaining('"Skirt logo"'),
        issues: [expect.objectContaining({ path: 'cap-flat/38mm/skirt' })],
      });
    });

    it('replaces a draft without being asked — that is what drafts are for', async () => {
      const draft = loadPack('box-basic') as { key: string; version: string; name: string };
      draft.key = 'box-redraft';
      draft.version = '0.1.0';
      expect((await importPack(sql, draft)).status).toBe('created');

      draft.name = 'Box, second go';
      expect((await importPack(sql, draft)).status).toBe('replaced');
    });

    it('refuses a pack with blocking problems, and says what they are', async () => {
      const broken = loadPack('cap-basic') as {
        products: { variants: { zones: { sizeMm: { safeMarginMm: number } }[] }[] }[];
      };
      broken.products[0]!.variants[0]!.zones[0]!.sizeMm.safeMarginMm = 100;

      await expect(importPack(sql, broken)).rejects.toBeInstanceOf(PackImportError);
      await expect(importPack(sql, broken)).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'safe_margin_too_large' })]),
      });
    });

    it('leaves an unpublished pack out of the catalog until it is published', async () => {
      const draft = loadPack('box-basic') as { key: string; version: string };
      draft.key = 'box-draft';
      draft.version = '0.1.0';

      const result = await importPack(sql, draft);
      expect(await visibleKeys(orgs.alpha)).not.toContain('box-draft');

      await publishPack(sql, result.packId);
      expect(await visibleKeys(orgs.alpha)).toContain('box-draft');
    });

    it('honours per-organisation visibility', async () => {
      const scoped = loadPack('cap-basic') as { key: string; version: string };
      scoped.key = 'cap-alpha-only';
      scoped.version = '1.0.0';

      await importPack(sql, scoped, { publish: true, visibleToOrgIds: [orgs.alpha] });

      expect(await visibleKeys(orgs.alpha)).toContain('cap-alpha-only');
      expect(await visibleKeys(orgs.beta)).not.toContain('cap-alpha-only');
    });
  });

  describe('reads', () => {
    it('returns products with their variants, zones and assets', async () => {
      const products = await listProducts(sql, tenant(orgs.beta));
      const carton = products.find((p) => p.productKey === 'carton-tuck');

      expect(carton).toBeTruthy();
      expect(carton!.category).toBe('cartons');

      const variant = carton!.variants[0]!;
      expect(variant.bboxMm).toHaveLength(2);
      expect(variant.materialSlots[0]!.defaultMaterialKey).toBe('pp-matte');
      expect(variant.cameraPresets.length).toBeGreaterThan(0);
      expect(variant.assets.lod0).toMatch(/^packs\/box-basic\/1\.0\.0\/meshes\//);
    });

    it('rebuilds zone definitions faithfully enough to place artwork on', async () => {
      const products = await listProducts(sql, tenant(orgs.alpha));
      const cap = products.find((p) => p.productKey === 'cap-flat')!;
      const zones = cap.variants[0]!.zones;

      const top = zones.find((z) => z.key === 'top')!;
      const skirt = zones.find((z) => z.key === 'skirt')!;

      expect(top.type).toBe('planar');
      expect(skirt.type).toBe('cylindrical');
      if (skirt.type === 'cylindrical') {
        expect(skirt.frame.radiusMm).toBe(19);
        expect(skirt.sizeMm.arcWidthMm).toBe(40);
      }
      expect(top.constraints.finishes).toContain('deboss');
    });

    it('filters by category and search text', async () => {
      const closures = await listProducts(sql, tenant(orgs.alpha), { category: 'closures' });
      expect(closures.every((p) => p.category === 'closures')).toBe(true);

      const found = await listProducts(sql, tenant(orgs.alpha), { search: 'carton' });
      expect(found.some((p) => p.productKey === 'carton-tuck')).toBe(true);
    });

    it('shows an unknown organisation the public catalog and nothing restricted', async () => {
      // Packs with no visibility rows are public by design; restricted ones must stay invisible even
      // to an organisation the policy has never heard of.
      const stranger = { orgId: '00000000-0000-7000-8000-0000000000ff', userId: null };
      const keys = (await listProducts(sql, stranger)).map((p) => p.packKey);

      expect(keys).toContain('cap-basic');
      expect(keys).not.toContain('cap-alpha-only');
    });
  });

  const visibleKeys = async (orgId: string) =>
    (await listProducts(sql, tenant(orgId))).map((p) => p.packKey);

  describe('finding a product (F-CAT-02)', () => {
    it('filters on the facets the packs declare, whatever they are', async () => {
      const all = await listProducts(sql, tenant(orgs.alpha));
      const facets = summariseFacets(all);
      expect(facets.length).toBeGreaterThan(0);

      const facet = facets[0]!;
      const value = facet.values[0]!;
      const narrowed = await listProducts(sql, tenant(orgs.alpha), {
        facets: { [facet.key]: value.value },
      });

      expect(narrowed.length).toBe(value.count);
      for (const product of narrowed) {
        expect(String(product.facets[facet.key])).toBe(value.value);
      }
    });

    it('matches a numeric facet written as a number and asked for as text', async () => {
      const all = await listProducts(sql, tenant(orgs.alpha));
      const numeric = all
        .flatMap((product) => Object.entries(product.facets))
        .find(([, value]) => typeof value === 'number');
      if (!numeric) return; // no numeric facets in the fixtures

      const [key, value] = numeric;
      const narrowed = await listProducts(sql, tenant(orgs.alpha), { facets: { [key]: String(value) } });
      expect(narrowed.length).toBeGreaterThan(0);
    });

    it('searches by name as well', async () => {
      const all = await listProducts(sql, tenant(orgs.alpha));
      const first = all[0]!;

      const found = await listProducts(sql, tenant(orgs.alpha), {
        search: first.name.slice(0, 4),
      });
      expect(found.map((product) => product.productKey)).toContain(first.productKey);
    });
  });
});
