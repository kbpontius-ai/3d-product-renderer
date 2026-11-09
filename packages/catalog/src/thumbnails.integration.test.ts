import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  withTenant,
  type TestDatabase,
} from '@pr/db';
import { localStorage } from '@pr/storage';
import { encodeRgbaPng } from '@pr/artwork/png';
import { importPack } from './import.js';
import { listPacks } from './packs.js';
import { listProducts } from './query.js';
import { listThumbnailVariants, saveCatalogThumbnail, validateThumbnailPng } from './thumbnails.js';
const png = encodeRgbaPng(new Uint8Array(768 * 576 * 4).fill(255), 768, 576);
describe('Catalog PNG boundary', () => {
  it('accepts a canvas PNG and rejects empty, truncated, corrupt and wrong-sized files', () => {
    expect(() => validateThumbnailPng(png)).not.toThrow();
    for (const bytes of [
      new Uint8Array(),
      png.slice(0, -20),
      encodeRgbaPng(new Uint8Array(4), 1, 1),
    ])
      expect(() => validateThumbnailPng(bytes)).toThrow();
    const corrupt = Uint8Array.from(png);
    corrupt[40] = corrupt[40]! ^ 255;
    expect(() => validateThumbnailPng(corrupt)).toThrow();
    expect(() => validateThumbnailPng(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow();
  });
});
describe.skipIf(!hasDatabase)('Catalog viewer captures (F-CAT-08)', () => {
  let db: TestDatabase;
  let directory: string;
  let packId: string;
  let variantId: string;
  let orgs: { alpha: string; beta: string };
  let original: unknown;
  beforeAll(async () => {
    db = await createTestDatabase('pr_captures');
    orgs = await seedOrganizations(db.sql);
    directory = await mkdtemp(join(tmpdir(), 'pr-capture-'));
    await importPack(
      db.sql,
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url),
          ),
          'utf8',
        ),
      ),
      { publish: true },
    );
    packId = (await listPacks(db.sql))[0]!.id;
    variantId = (await listThumbnailVariants(db.sql, packId))[0]!.id;
    await withStaff(db.sql, async (tx) => {
      const [pack] = await tx`select manifest from product_packs where id=${packId}`;
      original = pack!['manifest'];
    });
  }, 60000);
  afterAll(async () => {
    await db?.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const save = () =>
    saveCatalogThumbnail(db.sql, localStorage(directory), {
      packId,
      variantId,
      png,
      actorId: null,
    });
  it('validates product membership before writing a file', async () => {
    await expect(
      saveCatalogThumbnail(db.sql, localStorage(directory), {
        packId: orgs.alpha,
        variantId,
        png,
        actorId: null,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await localStorage(directory).list('packs')).toEqual([]);
  });
  it('publishes the captured image through the ordinary Catalog read', async () => {
    const key = await save();
    expect(await localStorage(directory).has(key)).toBe(true);
    const products = await listProducts(db.sql, { orgId: orgs.alpha, userId: null });
    expect(products[0]!.variants[0]!.assets.thumbnail).toBe(key);
  });
  it('keeps the old preview and cleans uploaded files if the transaction fails', async () => {
    const old = (await listThumbnailVariants(db.sql, packId))[0]!.thumbnailKey;
    const storage = localStorage(directory);
    const before = await storage.list('packs');
    await withStaff(db.sql, async (tx) => {
      await tx`create function reject_capture() returns trigger language plpgsql as $$ begin raise exception 'test storage pointer failure'; end $$`;
      await tx`create trigger reject_capture before insert on catalog_thumbnails for each row execute function reject_capture()`;
    });
    try {
      await expect(save()).rejects.toThrow('test storage pointer failure');
    } finally {
      await withStaff(db.sql, async (tx) => {
        await tx`drop trigger reject_capture on catalog_thumbnails`;
        await tx`drop function reject_capture()`;
      });
    }
    expect((await listThumbnailVariants(db.sql, packId))[0]!.thumbnailKey).toBe(old);
    expect(await storage.list('packs')).toEqual(before);
  });
  it('retains the old preview if storage fails', async () => {
    const old = (await listThumbnailVariants(db.sql, packId))[0]!.thumbnailKey;
    const backing = localStorage(directory);
    const before = await backing.list('packs');
    const storage = {
      ...backing,
      put: async (key: string, bytes: Uint8Array, contentType: string) => {
        await backing.put(key, bytes, contentType);
        throw new Error('Storage offline');
      },
    };
    await expect(
      saveCatalogThumbnail(db.sql, storage, { packId, variantId, png, actorId: null }),
    ).rejects.toThrow('Storage offline');
    expect(await backing.list('packs')).toEqual(before);
    expect((await listThumbnailVariants(db.sql, packId))[0]!.thumbnailKey).toBe(old);
  });
  it('serializes concurrent replacements and leaves immutable image keys', async () => {
    const keys = await Promise.all([save(), save()]);
    expect(keys[0]).not.toBe(keys[1]);
    const current = (await listThumbnailVariants(db.sql, packId))[0]!.thumbnailKey;
    expect(keys).toContain(current);
    for (const key of keys) expect(await localStorage(directory).has(key)).toBe(true);
  });
  it('allows visible metadata reads but refuses ordinary tenant writes', async () => {
    for (const orgId of [orgs.alpha, orgs.beta]) {
      await withTenant(db.sql, { orgId, userId: null }, async (tx) =>
        expect(await tx`select variant_id from catalog_thumbnails`).toHaveLength(1),
      );
      await expect(
        withTenant(
          db.sql,
          { orgId, userId: null },
          (tx) =>
            tx`insert into catalog_thumbnails(variant_id,storage_key) values (${variantId},'packs/no.png') on conflict(variant_id) do update set storage_key=excluded.storage_key`,
        ),
      ).rejects.toThrow();
    }
  });
  it('inherits pack visibility', async () => {
    await withStaff(
      db.sql,
      (tx) => tx`insert into pack_visibility(pack_id,org_id) values (${packId},${orgs.alpha})`,
    );
    await withTenant(db.sql, { orgId: orgs.beta, userId: null }, async (tx) =>
      expect(await tx`select variant_id from catalog_thumbnails`).toHaveLength(0),
    );
    await withStaff(db.sql, (tx) => tx`delete from pack_visibility where pack_id=${packId}`);
  });
  it('does not change manifests or create customer designs/renders', async () => {
    await withStaff(db.sql, async (tx) => {
      const [pack] = await tx`select manifest from product_packs where id=${packId}`;
      expect(pack!['manifest']).toEqual(original);
      for (const table of ['designs', 'render_jobs']) {
        const [r] = await tx`select count(*)::int as n from ${tx(table)}`;
        expect(r!['n']).toBe(0);
      }
    });
  });
});
