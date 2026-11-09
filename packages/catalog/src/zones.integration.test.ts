import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import type { PackManifest } from '@pr/design-schema';
import { createDraftVersion, importPack, publishPack, storageKey } from './import.js';
import { getDesignProduct } from './query.js';
import { addZone, getPackAuthoring, removeZone, updateZone, ZoneEditError } from './zones.js';

/**
 * Adding, moving and removing zones, and drafting a new version to do it on (F-ADM-13).
 *
 * Against a real database because the rules that matter are about state the database holds: which
 * packs are drafts, which designs point at which zone, and whether the stored manifest and the
 * derived rows still agree afterwards.
 */

const loadPack = (key: string): PackManifest =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/packs/${key}/manifest.json`, import.meta.url)),
      'utf8',
    ),
  ) as PackManifest;

const constraints = {
  finishes: ['emboss'],
  maxDepthMm: 0.6,
  minStrokeMm: 0.25,
  maxCoverage: 0.9,
  wrapWarnDeg: 120,
};

const flatFace = (name: string) => ({
  type: 'planar',
  name,
  frame: { originMm: [0, 18, 0], normal: [0, 1, 0], tangent: [1, 0, 0] },
  sizeMm: { width: 20, height: 12, safeMarginMm: 1 },
  constraints,
});

/** In-memory object storage, standing in for the real one's read and write. */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    read: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`no object at ${key}`);
      return bytes;
    },
    write: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes);
    },
  };
}

describe.skipIf(!hasDatabase)('zone authoring', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgs: { alpha: string; beta: string };
  const storage = memoryStorage();

  /** A draft made the way an upload makes one: a real pack with every zone taken out. */
  async function importEmptyDraft(key: string): Promise<string> {
    const manifest = loadPack('cap-basic');
    manifest.key = key;
    manifest.version = '0.1.0';
    for (const product of manifest.products)
      for (const variant of product.variants) variant.zones = [];
    const result = await importPack(sql, manifest, {
      assets: { read: async (path) => new TextEncoder().encode(path), write: storage.write },
    });
    return result.packId;
  }

  const address = (packId: string) => ({ packId, productKey: 'cap-flat', variantKey: '38mm' });

  const zoneRows = async (packId: string) =>
    withStaff(
      sql,
      (tx) => tx`
      select z.key, z.frame from decoration_zones z
      join product_variants v on v.id = z.variant_id
      join products p on p.id = v.product_id
      where p.pack_id = ${packId} order by z.sort`,
    );

  beforeAll(async () => {
    db = await createTestDatabase('pr_zones');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('getPackAuthoring', () => {
    it('lists a variant that has no zones yet, with the facts measured for it', async () => {
      // The bug this feature started from: the page listed variants *from their zones*, so a pack
      // made from an upload showed nothing at all.
      const packId = await importEmptyDraft('authoring-empty');
      const authoring = await getPackAuthoring(sql, packId);

      expect(authoring.status).toBe('draft');
      expect(authoring.variants).toHaveLength(1);
      expect(authoring.variants[0]!.zones).toEqual([]);
      expect(authoring.variants[0]!.bboxMm).toHaveLength(2);
      expect(authoring.variants[0]!.meshKey).toBe(
        'packs/authoring-empty/0.1.0/meshes/cap-flat/38mm/lod0.glb',
      );
    });
  });

  describe('addZone', () => {
    it('adds a zone to a draft, keyed from its name, in the manifest and the rows alike', async () => {
      const packId = await importEmptyDraft('add-basic');

      expect(await addZone(sql, address(packId), flatFace('Top face'), null)).toBe('top-face');
      // A different name that makes the same key still gets a key of its own.
      expect(await addZone(sql, address(packId), flatFace('Top-face'), null)).toBe('top-face-2');

      const authoring = await getPackAuthoring(sql, packId);
      expect(authoring.variants[0]!.zones.map((zone) => zone.key)).toEqual([
        'top-face',
        'top-face-2',
      ]);
      expect((await zoneRows(packId)).map((row) => row['key'])).toEqual(['top-face', 'top-face-2']);
    });

    it('refuses a second zone with the same name', async () => {
      // Customers choose a zone by its name in the editor; two called "Lid logo" cannot be told apart.
      const packId = await importEmptyDraft('add-duplicate-name');
      await addZone(sql, address(packId), flatFace('Lid logo'), null);

      await expect(
        addZone(sql, address(packId), flatFace('lid LOGO '), null),
      ).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('already called'),
      });

      const other = await addZone(sql, address(packId), flatFace('Skirt text'), null);
      await expect(
        updateZone(sql, { ...address(packId), zoneKey: other }, { name: 'Lid Logo' }, null),
      ).rejects.toMatchObject({ message: expect.stringContaining('already called') });
    });

    it('refuses a zone that is not complete, and says which field', async () => {
      const packId = await importEmptyDraft('add-incomplete');
      const missing = { ...flatFace('Top'), frame: { originMm: [0, 18, 0], normal: [0, 1, 0] } };

      await expect(addZone(sql, address(packId), missing, null)).rejects.toMatchObject({
        code: 'invalid',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'frame.tangent' })]),
      });
      expect(await zoneRows(packId)).toHaveLength(0);
    });

    it('refuses a zone the whole pack would not accept', async () => {
      // Validated in context, as edits are: a margin that swallows the zone leaves nothing to print.
      const packId = await importEmptyDraft('add-context');
      const swallowed = { ...flatFace('Top'), sizeMm: { width: 20, height: 12, safeMarginMm: 50 } };

      await expect(addZone(sql, address(packId), swallowed, null)).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'safe_margin_too_large' }),
        ]),
      });
    });

    it('offers only the zone types that address the part in millimetres', async () => {
      const packId = await importEmptyDraft('add-types');
      const uv = { ...flatFace('Label'), type: 'uv_rect', uvRect: { u0: 0, v0: 0, u1: 1, v1: 1 } };
      await expect(addZone(sql, address(packId), uv, null)).rejects.toBeInstanceOf(ZoneEditError);
    });

    it('never adds to a published pack', async () => {
      const packId = await importEmptyDraft('add-published');
      await publishPack(sql, packId);

      await expect(addZone(sql, address(packId), flatFace('Top'), null)).rejects.toMatchObject({
        code: 'not_draft',
      });
    });
  });

  it('retains the target through publication and catalog reads, with safe update rules', async () => {
    const packId = await importEmptyDraft('target-retained');
    const slot = (await getPackAuthoring(sql, packId)).variants[0]!.materialSlots[0]!.key;
    const key = await addZone(
      sql,
      address(packId),
      { ...flatFace('Targeted'), materialSlotKey: slot },
      null,
    );
    const zoneAddress = { ...address(packId), zoneKey: key };
    expect((await getPackAuthoring(sql, packId)).variants[0]!.zones[0]!.materialSlotKey).toBe(slot);
    await expect(
      updateZone(sql, zoneAddress, { materialSlotKey: 'missing' }, null),
    ).rejects.toMatchObject({ code: 'invalid' });
    await updateZone(sql, zoneAddress, { materialSlotKey: null }, null);
    expect(
      (await getPackAuthoring(sql, packId)).variants[0]!.zones[0]!.materialSlotKey,
    ).toBeUndefined();
    await updateZone(sql, zoneAddress, { materialSlotKey: slot }, null);
    await publishPack(sql, packId);
    await withStaff(
      sql,
      (tx) => tx`insert into pack_visibility (pack_id, org_id) values (${packId}, ${orgs.alpha})`,
    );
    const product = await getDesignProduct(
      sql,
      { orgId: orgs.alpha, userId: null },
      { packKey: 'target-retained', packVersion: '0.1.0', productKey: 'cap-flat' },
    );
    expect(product?.variants[0]!.zones[0]!.materialSlotKey).toBe(slot);
    await expect(
      updateZone(sql, zoneAddress, { materialSlotKey: null }, null),
    ).rejects.toMatchObject({ code: 'not_draft' });
  });

  describe('moving a zone', () => {
    it('moves a zone on a draft, and the row follows the manifest', async () => {
      const packId = await importEmptyDraft('move-draft');
      const key = await addZone(sql, address(packId), flatFace('Top'), null);
      const frame = { originMm: [2, 18, -3], normal: [0, 1, 0], tangent: [0, 0, 1] };

      await updateZone(sql, { ...address(packId), zoneKey: key }, { frame }, null);

      const [zone] = (await getPackAuthoring(sql, packId)).variants[0]!.zones;
      expect(zone).toMatchObject({ frame });
      expect((await zoneRows(packId))[0]!['frame']).toEqual(frame);
    });

    it('refuses a frame that does not fit the zone type', async () => {
      const packId = await importEmptyDraft('move-shape');
      const key = await addZone(sql, address(packId), flatFace('Top'), null);

      await expect(
        updateZone(
          sql,
          { ...address(packId), zoneKey: key },
          { frame: { axisDir: [0, 1, 0] } },
          null,
        ),
      ).rejects.toMatchObject({ code: 'invalid' });
    });

    it('never moves a zone on a published pack, but still lets its size be adjusted', async () => {
      // A published version is what designs point at; moving a zone under one moves its logo. Size,
      // margin and finishes were adjustable on published packs before this feature, and still are.
      const packId = await importEmptyDraft('move-published');
      const key = await addZone(sql, address(packId), flatFace('Top'), null);
      await publishPack(sql, packId);

      const zone = { ...address(packId), zoneKey: key };
      await expect(
        updateZone(
          sql,
          zone,
          { frame: { originMm: [5, 18, 0], normal: [0, 1, 0], tangent: [1, 0, 0] } },
          null,
        ),
      ).rejects.toMatchObject({ code: 'not_draft' });

      await updateZone(sql, zone, { safeMarginMm: 2 }, null);
      expect((await getPackAuthoring(sql, packId)).variants[0]!.zones[0]!.sizeMm.safeMarginMm).toBe(
        2,
      );
    });
  });

  /**
   * A pack with a customer's design on one of its zones, set back to draft afterwards.
   *
   * Designs can only be made on published packs, and a pack can be moved back to draft through the
   * API — so this is how a draft ends up with designs on it, and why draft-only is not enough.
   */
  async function draftWithDesign(
    key: string,
  ): Promise<{ packId: string; zoneKey: string; designId: string }> {
    const { createDesign } = await import('@pr/designs');
    const { setPackStatus } = await import('./packs.js');
    const packId = await importEmptyDraft(key);
    const zoneKey = await addZone(sql, address(packId), flatFace('Top'), null);
    await publishPack(sql, packId);

    const variantId = (await getPackAuthoring(sql, packId)).variants[0]!.variantId;
    const design = await createDesign(
      sql,
      { orgId: orgs.alpha, userId: null },
      { variantId, name: 'Customer logo' },
    );
    await withStaff(
      sql,
      (tx) => tx`
      update design_versions
      set document = jsonb_set(document, '{placements}', ${tx.json([{ zoneKey }] as never)})
      where design_id = ${design.id}`,
    );

    await setPackStatus(sql, packId, 'draft', null);
    return { packId, zoneKey, designId: design.id };
  }

  describe('mapping changes', () => {
    it('converts an unused draft in both directions and keeps manifest and row aligned', async () => {
      const packId = await importEmptyDraft('mapping-roundtrip');
      const zoneKey = await addZone(sql, address(packId), flatFace('Top'), null);
      const target = { ...address(packId), zoneKey };
      const frame = { ...flatFace('Top').frame, maxProjectionDepthMm: 8 };
      await updateZone(sql, target, { mapping: 'conformal', frame }, null);
      const [stored] = await withStaff(
        sql,
        (tx) =>
          tx`select z.type,z.frame from decoration_zones z join product_variants v on v.id=z.variant_id join products p on p.id=v.product_id where p.pack_id=${packId} and z.key=${zoneKey}`,
      );
      expect(stored).toMatchObject({ type: 'conformal', frame });
      expect((await getPackAuthoring(sql, packId)).variants[0]!.zones[0]!.type).toBe('conformal');
      await updateZone(sql, target, { mapping: 'planar', frame: flatFace('Top').frame }, null);
      expect((await getPackAuthoring(sql, packId)).variants[0]!.zones[0]).toMatchObject({
        type: 'planar',
        key: zoneKey,
        name: 'Top',
        sizeMm: flatFace('Top').sizeMm,
      });
    });
    it('refuses published and in-use mapping changes', async () => {
      const packId = await importEmptyDraft('mapping-published');
      const zoneKey = await addZone(sql, address(packId), flatFace('Top'), null);
      await publishPack(sql, packId);
      const patch = {
        mapping: 'conformal' as const,
        frame: { ...flatFace('Top').frame, maxProjectionDepthMm: 8 },
      };
      await expect(
        updateZone(sql, { ...address(packId), zoneKey }, patch, null),
      ).rejects.toMatchObject({ code: 'not_draft' });
      const used = await draftWithDesign('mapping-used');
      await expect(
        updateZone(sql, { ...address(used.packId), zoneKey: used.zoneKey }, patch, null),
      ).rejects.toMatchObject({ code: 'in_use' });
    });
    it('refuses incomplete frames without changing the saved mapping', async () => {
      const packId = await importEmptyDraft('mapping-invalid');
      const zoneKey = await addZone(sql, address(packId), flatFace('Top'), null);
      const target = { ...address(packId), zoneKey };
      await expect(updateZone(sql, target, { mapping: 'conformal' }, null)).rejects.toMatchObject({
        code: 'invalid',
      });
      await expect(
        updateZone(sql, target, { mapping: 'conformal', frame: flatFace('Top').frame }, null),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect((await getPackAuthoring(sql, packId)).variants[0]!.zones[0]!.type).toBe('planar');
    });
  });

  describe('designs on a draft', () => {
    it('keep their zone where it is, even though the pack is a draft again', async () => {
      const { packId, zoneKey } = await draftWithDesign('move-in-use');
      const frame = { originMm: [5, 18, 0], normal: [0, 1, 0], tangent: [1, 0, 0] };

      await expect(
        updateZone(sql, { ...address(packId), zoneKey }, { frame }, null),
      ).rejects.toMatchObject({
        code: 'in_use',
      });
    });
  });

  it('does not retarget a zone already used by a design', async () => {
    const { packId, zoneKey } = await draftWithDesign('target-in-use');
    await expect(
      updateZone(sql, { ...address(packId), zoneKey }, { materialSlotKey: 'cap' }, null),
    ).rejects.toMatchObject({ code: 'in_use' });
  });

  describe('removeZone', () => {
    it('refuses while a design places artwork in the zone, and names it', async () => {
      const { packId, zoneKey, designId } = await draftWithDesign('remove-in-use');

      await expect(removeZone(sql, { ...address(packId), zoneKey }, null)).rejects.toMatchObject({
        code: 'in_use',
        // Names the design, gets the grammar right, and says what to do about it.
        message: expect.stringMatching(/1 design places artwork in it \("Customer logo"\).*delete/),
      });

      // Once the design is gone, so is the reason to keep the zone.
      await withStaff(
        sql,
        (tx) => tx`update designs set deleted_at = now() where id = ${designId}`,
      );
      await removeZone(sql, { ...address(packId), zoneKey }, null);
      expect((await getPackAuthoring(sql, packId)).variants[0]!.zones).toEqual([]);
      expect(await zoneRows(packId)).toHaveLength(0);
    });

    it('never removes from a published pack', async () => {
      const packId = await importEmptyDraft('remove-published');
      const key = await addZone(sql, address(packId), flatFace('Top'), null);
      await publishPack(sql, packId);

      await expect(
        removeZone(sql, { ...address(packId), zoneKey: key }, null),
      ).rejects.toMatchObject({
        code: 'not_draft',
      });
    });
  });

  describe('createDraftVersion', () => {
    it('copies a published pack into a new draft, leaving the published one exactly as it was', async () => {
      const packId = await importEmptyDraft('versioned');
      await addZone(sql, address(packId), flatFace('Top'), null);
      await publishPack(sql, packId);
      await withStaff(
        sql,
        (tx) => tx`insert into pack_visibility (pack_id, org_id) values (${packId}, ${orgs.alpha})`,
      );

      const copy = await createDraftVersion(sql, packId, storage, null);

      expect(copy.version).toBe('0.2.0');
      const draft = await getPackAuthoring(sql, copy.packId);
      expect(draft.status).toBe('draft');
      expect(draft.variants[0]!.zones.map((zone) => zone.key)).toEqual(['top']);

      // Its meshes live under its own version, so nothing it does can touch the published files.
      const mesh = 'meshes/cap-flat/38mm/lod0.glb';
      expect(storage.objects.get(storageKey(loadPackAt('versioned', '0.2.0'), mesh))).toEqual(
        storage.objects.get(storageKey(loadPackAt('versioned', '0.1.0'), mesh)),
      );

      const visible = await withStaff(
        sql,
        (tx) => tx`select org_id from pack_visibility where pack_id = ${copy.packId}`,
      );
      expect(visible.map((row) => row['org_id'])).toEqual([orgs.alpha]);

      const original = await getPackAuthoring(sql, packId);
      expect(original.status).toBe('published');
      expect(original.version).toBe('0.1.0');

      // Asking again opens the draft that already exists rather than starting a second one.
      const again = await createDraftVersion(sql, packId, storage, null);
      expect(again.packId).toBe(copy.packId);
      expect(again.version).toBe('0.2.0');
      expect(again.status).toBe('unchanged');
    });
  });
});

/** Just enough of a manifest for `storageKey`, which only reads the key and version. */
const loadPackAt = (key: string, version: string) => ({ key, version }) as PackManifest;
