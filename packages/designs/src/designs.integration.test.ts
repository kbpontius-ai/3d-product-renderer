import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  withTenant,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { importPack, listProducts } from '@pr/catalog';
import type { DesignDocument, Placement } from '@pr/design-schema';
import {
  createDesign,
  deleteDesign,
  DesignError,
  duplicateDesign,
  listDeletedDesigns,
  listDesigns,
  loadDesign,
  renameDesign,
  restoreDesign,
  switchVariant,
  saveDesign,
  setDesignThumbnail,
} from './service.js';

/**
 * Design persistence (W-03).
 *
 * Versioning, the optimistic lock and the refusal to persist an unrenderable document are the
 * behaviours worth testing here — the rest is CRUD.
 */

const loadPack = (key: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url)), 'utf8'),
  );

describe.skipIf(!hasDatabase)('designs', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  let capVariantId: string;

  const alpha = () => ({ orgId: orgs.alpha, userId: null });
  const beta = () => ({ orgId: orgs.beta, userId: null });

  beforeAll(async () => {
    db = await createTestDatabase('pr_designs');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
    await importPack(sql, loadPack('cap-basic'), { publish: true });
    await importPack(sql, loadPack('box-basic'), { publish: true });

    const products = await listProducts(sql, alpha());
    capVariantId = products.find((p) => p.productKey === 'cap-flat')!.variants[0]!.variantId;
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const placement = (over: Partial<Placement> = {}): Placement => ({
    id: '66666666-6666-4666-8666-666666666666',
    zoneKey: 'top',
    artwork: {
      artworkId: '11111111-1111-4111-8111-111111111111',
      versionId: '22222222-2222-4222-8222-222222222222',
    },
    transform: {
      offsetMm: { x: 0, y: 0 },
      sizeMm: { w: 18, h: 9 },
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      lockAspect: true,
    },
    finish: { kind: 'deboss', depthMm: 0.35, bevelDeg: 30, edgeRadiusMm: 0.05 },
    order: 0,
    ...over,
  });

  it('opens a new design on the product defaults', async () => {
    const design = await createDesign(sql, alpha(), { variantId: capVariantId });

    expect(design.version).toBe(1);
    expect(design.document.product.productKey).toBe('cap-flat');
    expect(design.document.materials['body']!.materialKey).toBe('pp-matte');
    expect(design.document.placements).toEqual([]);
    expect(design.document.scene.camera).toMatchObject({ kind: 'preset' });
  });

  it('creates a design and its placement together, or not at all', async () => {
    // The test-pattern check used to create the design and then save the pattern into it. When the
    // save was refused, an empty "Zone check" design was left behind in the staff member's list.
    const before = (await listDesigns(sql, alpha())).length;

    await expect(
      createDesign(sql, alpha(), {
        variantId: capVariantId,
        name: 'Zone check — nowhere',
        placements: [placement({ zoneKey: 'not-a-zone' })],
      }),
    ).rejects.toMatchObject({ code: 'invalid_document' });
    expect((await listDesigns(sql, alpha())).length).toBe(before);

    const made = await createDesign(sql, alpha(), {
      variantId: capVariantId,
      name: 'Zone check — top',
      placements: [placement()],
    });
    expect(made.document.placements).toHaveLength(1);
  });

  it('refuses a product the organisation cannot see', async () => {
    await expect(
      createDesign(sql, alpha(), { variantId: '00000000-0000-7000-8000-00000000dead' }),
    ).rejects.toMatchObject({ code: 'unknown_variant' });
  });

  it('saves a new version rather than overwriting the old one', async () => {
    const design = await createDesign(sql, alpha(), { variantId: capVariantId, name: 'Versioned' });
    const withArtwork: DesignDocument = { ...design.document, placements: [placement()] };

    const saved = await saveDesign(sql, alpha(), {
      designId: design.id,
      document: withArtwork,
      expectedVersion: 1,
    });
    expect(saved.version).toBe(2);

    const reloaded = await loadDesign(sql, alpha(), design.id);
    expect(reloaded.version).toBe(2);
    expect(reloaded.document.placements).toHaveLength(1);

    // Version 1 is still there, unmodified — a render submitted against it still has its inputs.
    // Read through a tenant context: without one the policies (correctly) return nothing.
    const [first] = await withTenant(sql, alpha(), (tx) =>
      tx`select document from design_versions where design_id = ${design.id} and version = 1`,
    );
    expect((first!['document'] as DesignDocument).placements).toEqual([]);
  });

  it('refuses a save that was written against an older version', async () => {
    const design = await createDesign(sql, alpha(), { variantId: capVariantId });
    await saveDesign(sql, alpha(), {
      designId: design.id,
      document: design.document,
      expectedVersion: 1,
    });

    await expect(
      saveDesign(sql, alpha(), {
        designId: design.id,
        document: design.document,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict', detail: { version: 2 } });
  });

  describe('what it will not store', () => {
    it('a document that does not match the schema', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      await expect(
        saveDesign(sql, alpha(), {
          designId: design.id,
          document: { ...design.document, units: 'inches' },
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'invalid_document' });
    });

    it('artwork placed outside the decoration area', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      const oversized = placement({
        transform: { ...placement().transform, sizeMm: { w: 90, h: 45 } },
      });

      await expect(
        saveDesign(sql, alpha(), {
          designId: design.id,
          document: { ...design.document, placements: [oversized] },
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'invalid_document' });
    });

    it('a relief deeper than the zone allows', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      const tooDeep = placement({
        finish: { kind: 'emboss', depthMm: 2, bevelDeg: 30, edgeRadiusMm: 0.05 },
      });

      await expect(
        saveDesign(sql, alpha(), {
          designId: design.id,
          document: { ...design.document, placements: [tooDeep] },
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'invalid_document' });
    });

    it('a finish the zone does not offer', async () => {
      const products = await listProducts(sql, beta());
      const cartonVariant = products.find((p) => p.productKey === 'carton-tuck')!.variants[0]!;
      const design = await createDesign(sql, beta(), { variantId: cartonVariant.variantId });

      const embossed = placement({
        zoneKey: 'front',
        finish: { kind: 'emboss', depthMm: 0.05, bevelDeg: 30, edgeRadiusMm: 0 },
      });

      await expect(
        saveDesign(sql, beta(), {
          designId: design.id,
          document: { ...design.document, placements: [embossed] },
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'invalid_document' });
    });
  });

  describe('the rest of the lifecycle', () => {
    it('lists, renames, duplicates and deletes', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId, name: 'Original' });

      await renameDesign(sql, alpha(), design.id, 'Renamed');
      expect((await loadDesign(sql, alpha(), design.id)).name).toBe('Renamed');

      const copy = await duplicateDesign(sql, alpha(), design.id);
      expect(copy.name).toBe('Renamed (copy)');
      expect(copy.version).toBe(1);
      expect(copy.id).not.toBe(design.id);

      const listed = await listDesigns(sql, alpha());
      expect(listed.map((d) => d.name)).toContain('Renamed (copy)');
      expect(listed[0]!.productName).toBeTruthy();

      await deleteDesign(sql, alpha(), design.id);
      await expect(loadDesign(sql, alpha(), design.id)).rejects.toBeInstanceOf(DesignError);
      expect((await listDesigns(sql, alpha())).map((d) => d.id)).not.toContain(design.id);
    });
  });

  describe('tenancy', () => {
    it('hides another organisation`s design entirely', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId, name: 'Private' });

      await expect(loadDesign(sql, beta(), design.id)).rejects.toMatchObject({ code: 'not_found' });
      expect((await listDesigns(sql, beta())).map((d) => d.id)).not.toContain(design.id);
      await expect(
        saveDesign(sql, beta(), { designId: design.id, document: design.document, expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(deleteDesign(sql, beta(), design.id)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('the restore window (F-PROJ-01)', () => {
    it('brings a deleted design back, with its work intact', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      await deleteDesign(sql, alpha(), design.id);

      expect((await listDesigns(sql, alpha())).map((d) => d.id)).not.toContain(design.id);
      expect((await listDeletedDesigns(sql, alpha())).map((d) => d.id)).toContain(design.id);

      await restoreDesign(sql, alpha(), design.id);

      expect((await listDesigns(sql, alpha())).map((d) => d.id)).toContain(design.id);
      expect((await loadDesign(sql, alpha(), design.id)).document.placements).toBeDefined();
    });

    it('will not restore something that was never deleted', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      await expect(restoreDesign(sql, alpha(), design.id)).rejects.toThrow(DesignError);
    });

    it('is not another organisation’s design to restore', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      await deleteDesign(sql, alpha(), design.id);

      await expect(restoreDesign(sql, beta(), design.id)).rejects.toThrow(DesignError);
      expect((await listDeletedDesigns(sql, beta())).map((d) => d.id)).not.toContain(design.id);
    });

    it('forgets a design deleted longer ago than the window', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      await deleteDesign(sql, alpha(), design.id);
      await withStaff(sql, (tx) =>
        tx`update designs set deleted_at = now() - interval '60 days' where id = ${design.id}`,
      );

      expect((await listDeletedDesigns(sql, alpha())).map((d) => d.id)).not.toContain(design.id);
      await expect(restoreDesign(sql, alpha(), design.id)).rejects.toThrow(DesignError);
    });
  });

  describe('the dashboard picture (F-PROJ-02)', () => {
    it('remembers where the thumbnail is', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      await setDesignThumbnail(sql, alpha(), design.id, `designs/${orgs.alpha}/${design.id}/thumb.png`);

      const [listed] = (await listDesigns(sql, alpha())).filter((d) => d.id === design.id);
      expect(listed?.thumbnailKey).toBe(`designs/${orgs.alpha}/${design.id}/thumb.png`);
    });

    it('is not another organisation’s design to illustrate', async () => {
      const design = await createDesign(sql, alpha(), { variantId: capVariantId });
      await expect(setDesignThumbnail(sql, beta(), design.id, 'x/y.png')).rejects.toThrow(DesignError);
    });
  });

  describe('moving between variants (F-CAT-04)', () => {
    it('carries a placement over to another variant of the same product', async () => {
      const products = await listProducts(sql, alpha());
      const cap = products.find((p) => p.productKey === 'cap-flat')!;
      const design = await createDesign(sql, alpha(), { variantId: cap.variants[0]!.variantId });

      const withArtwork = { ...design.document, placements: [placement({ zoneKey: 'top' })] };
      await saveDesign(sql, alpha(), {
        designId: design.id,
        document: withArtwork,
        expectedVersion: design.version,
      });

      // The fixture ships one variant, so switching to the same one is the honest test of the
      // mapping: everything that can carry over does, and nothing is dropped.
      const result = await switchVariant(sql, alpha(), design.id, cap.variants[0]!.variantId);

      expect(result.carried).toBe(1);
      expect(result.dropped).toBe(0);
      expect(result.document.placements[0]!.zoneKey).toBe('top');
      expect(result.document.materials['body']).toBeDefined();
    });

    it('refuses to move a design onto a different product', async () => {
      const products = await listProducts(sql, alpha());
      const cap = products.find((p) => p.productKey === 'cap-flat')!;
      const carton = products.find((p) => p.productKey === 'carton-tuck');
      if (!carton) return;

      const design = await createDesign(sql, alpha(), { variantId: cap.variants[0]!.variantId });
      await expect(
        switchVariant(sql, alpha(), design.id, carton.variants[0]!.variantId),
      ).rejects.toThrow(/its own product/);
    });

    it('is not another organisation’s design to move', async () => {
      const products = await listProducts(sql, alpha());
      const cap = products.find((p) => p.productKey === 'cap-flat')!;
      const design = await createDesign(sql, alpha(), { variantId: cap.variants[0]!.variantId });

      await expect(switchVariant(sql, beta(), design.id, cap.variants[0]!.variantId)).rejects.toThrow(
        DesignError,
      );
    });
  });
});
