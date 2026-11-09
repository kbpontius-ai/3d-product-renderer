import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { localStorage, type Storage } from '@pr/storage';
import {
  ArtworkError,
  deleteArtwork,
  ingestArtwork,
  listArtworks,
  loadArtworkVersion,
  renameArtwork,
  editArtwork,
  loadCurrentArtwork,
} from './service.js';

/**
 * Artwork ingest (W-04).
 *
 * The pipeline itself is tested exhaustively in `@pr/svg` and `@pr/raster`; what matters here is
 * what ingest adds — that a rejected file leaves no trace, that the same bytes are not processed
 * twice, and that one organisation's logo is invisible to another.
 */

const sample = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../fixtures/artwork/samples/${name}`, import.meta.url)),
    'utf8',
  );

const WORDMARK = sample('wordmark.svg');

/** A second, different mark: dedupe is by content, so the library tests need two of them. */
const SQUARE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">' +
  '<rect x="4" y="4" width="12" height="12" fill="#000"/></svg>';

describe.skipIf(!hasDatabase)('artwork ingest', () => {
  let db: TestDatabase;
  let sql: Sql;
  let storage: Storage;
  let root: string;
  let orgs: { alpha: string; beta: string };

  const alpha = () => ({ orgId: orgs.alpha, userId: null });
  const beta = () => ({ orgId: orgs.beta, userId: null });

  beforeAll(async () => {
    db = await createTestDatabase('pr_artworks');
    sql = db.sql;
    orgs = await seedOrganizations(sql);
    root = await mkdtemp(join(tmpdir(), 'pr-artworks-'));
    storage = localStorage(root);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('runs the pipeline and stores what the editor needs to draw', async () => {
    const result = await ingestArtwork(sql, storage, alpha(), {
      name: 'Wordmark',
      source: WORDMARK,
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    const { artwork } = result;
    expect(artwork.name).toBe('Wordmark');
    expect(artwork.naturalSizeMm.w).toBeGreaterThan(0);
    expect(artwork.mmPerPx).toBeGreaterThan(0);
    expect(artwork.widthPx).toBeGreaterThan(8);
    expect(artwork.sdfRangeMm[0]).toBeLessThan(0); // inside the mark, distances are negative
    expect(artwork.stats.coverage).toBeGreaterThan(0);

    // Four assets — sanitised source, mask, distance field, contours — and the mask is a real PNG
    // the browser can decode.
    const keys = await storage.list(`artwork/${orgs.alpha}`);
    expect(keys).toHaveLength(4);
    expect(keys.some((k) => k.endsWith('/sanitized.svg'))).toBe(true);
    expect(keys.some((k) => k.endsWith('/sdf.png'))).toBe(true);

    const mask = await storage.get(artwork.maskKey);
    expect(mask.contentType).toBe('image/png');
    expect([...mask.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('reuses the version when the same bytes come back', async () => {
    const first = await ingestArtwork(sql, storage, alpha(), { name: 'Again', source: WORDMARK });
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;

    expect(first.reused).toBe(true);
    // The name stays the one it was first stored under: this is the same artwork, not a new one.
    expect(first.artwork.name).toBe('Wordmark');
  });

  it('reloads a version by id, with everything the placement needs', async () => {
    const ingested = await ingestArtwork(sql, storage, alpha(), {
      name: 'Wordmark',
      source: WORDMARK,
    });
    if (ingested.status !== 'ready') throw new Error('expected ready');

    const loaded = await loadArtworkVersion(sql, alpha(), ingested.artwork.versionId);
    expect(loaded).toEqual(ingested.artwork);
  });

  describe('what it will not store', () => {
    it('an SVG with live text, and it says why', async () => {
      const before = (await storage.list(`artwork/${orgs.alpha}`)).length;
      const result = await ingestArtwork(sql, storage, alpha(), {
        name: 'Text',
        source: sample('text-not-outlined.svg'),
      });

      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') return;
      expect(result.report.errors.map((e) => e.code)).toContain('text_not_outlined');

      // Nothing written: no row to find and no bytes to sweep.
      expect(await storage.list(`artwork/${orgs.alpha}`)).toHaveLength(before);
      expect((await listArtworks(sql, alpha())).some((a) => a.name === 'Text')).toBe(false);
    });

    it('something that is not an SVG at all', async () => {
      const result = await ingestArtwork(sql, storage, alpha(), { name: 'Nope', source: 'hello' });
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') return;
      expect(result.report.errors[0]!.code).toBe('not_svg');
    });
  });

  it('cleans a hostile file rather than refusing it, and says what it removed', async () => {
    const result = await ingestArtwork(sql, storage, alpha(), {
      name: 'Hostile',
      source: sample('hostile.svg'),
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    const sanitized = await storage.get(
      result.artwork.maskKey.replace('mask.png', 'sanitized.svg'),
    );
    const text = new TextDecoder().decode(sanitized.bytes);
    expect(text).not.toContain('script');
    expect(text).not.toContain('onload');
    // The only URL left is the SVG namespace itself; nothing fetches anything.
    expect(text).not.toMatch(/href|<image|url\(/);
  });

  describe('tenancy', () => {
    it('keeps one organisation`s artwork out of another`s library and reach', async () => {
      const mine = await ingestArtwork(sql, storage, alpha(), {
        name: 'Private',
        source: WORDMARK,
      });
      if (mine.status !== 'ready') throw new Error('expected ready');

      await expect(loadArtworkVersion(sql, beta(), mine.artwork.versionId)).rejects.toBeInstanceOf(
        ArtworkError,
      );
      expect((await listArtworks(sql, beta())).map((a) => a.versionId)).not.toContain(
        mine.artwork.versionId,
      );
    });

    it('deduplicates within an organisation, not across them', async () => {
      const theirs = await ingestArtwork(sql, storage, beta(), {
        name: 'Theirs',
        source: WORDMARK,
      });
      expect(theirs.status).toBe('ready');
      if (theirs.status !== 'ready') return;

      // Same bytes, different tenant: their own copy, under their own key.
      expect(theirs.reused).toBe(false);
      expect(theirs.artwork.maskKey.startsWith(`artwork/${orgs.beta}/`)).toBe(true);
    });
  });

  describe('editing immutable artwork versions (F-ART-11)', () => {
    const upload = async (width: number) => {
      const result = await ingestArtwork(sql, storage, alpha(), {
        name: 'Editable',
        source: SQUARE.replace('width="20mm"', `width="${width}mm"`),
      });
      if (result.status !== 'ready') throw new Error('expected ready');
      return result.artwork;
    };
    const edit = (artwork: Awaited<ReturnType<typeof upload>>) => ({
      versionId: artwork.versionId,
      name: 'Edited',
      widthMm: artwork.naturalSizeMm.w * 2,
      heightMm: artwork.naturalSizeMm.h * 2,
      rotationDeg: 90,
      flipX: true,
      flipY: false,
    });

    it('keeps old source and derived assets intact while the library adopts the new version', async () => {
      const original = await upload(31);
      const source = await storage.get(original.sourceKey);
      const mask = await storage.get(original.maskKey);
      const result = await editArtwork(sql, storage, alpha(), original.artworkId, edit(original));
      if (result.status !== 'ready') throw new Error('edit rejected');
      expect(result.artwork.artworkId).toBe(original.artworkId);
      expect(result.artwork.versionId).not.toBe(original.versionId);
      expect(result.artwork.naturalSizeMm.w).toBeCloseTo(original.naturalSizeMm.h * 2, 3);
      expect(result.artwork.createdAt).toBe(original.createdAt);
      expect((await loadCurrentArtwork(sql, alpha(), original.artworkId)).versionId).toBe(
        result.artwork.versionId,
      );
      expect((await loadArtworkVersion(sql, alpha(), original.versionId)).maskKey).toBe(
        original.maskKey,
      );
      expect((await storage.get(original.sourceKey)).bytes).toEqual(source.bytes);
      expect((await storage.get(original.maskKey)).bytes).toEqual(mask.bytes);
      expect(
        (await listArtworks(sql, alpha())).filter((a) => a.artworkId === original.artworkId),
      ).toHaveLength(1);
    });

    it('renames without reprocessing or creating a geometry version', async () => {
      const original = await upload(32);
      const before = await storage.list(`artwork/${orgs.alpha}/${original.artworkId}`);
      const result = await editArtwork(sql, storage, alpha(), original.artworkId, {
        ...edit(original),
        widthMm: original.naturalSizeMm.w,
        heightMm: original.naturalSizeMm.h,
        rotationDeg: 0,
        flipX: false,
      });
      if (result.status !== 'ready') throw new Error('edit rejected');
      expect(result.artwork.versionId).toBe(original.versionId);
      expect(result.artwork.name).toBe('Edited');
      expect(await storage.list(`artwork/${orgs.alpha}/${original.artworkId}`)).toEqual(before);
    });

    // Two edits each run the whole pipeline at once. On CI's two-core runner that contends with the
    // other test files and takes 3.5 to 6 s, against 1.4 s locally, so the 5 s default is too tight.
    it('rejects stale saves, including competing edits, without orphaned assets', async () => {
      const original = await upload(33);
      const results = await Promise.allSettled([
        editArtwork(sql, storage, alpha(), original.artworkId, edit(original)),
        editArtwork(sql, storage, alpha(), original.artworkId, {
          ...edit(original),
          rotationDeg: 45,
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason.code).toBe('version_conflict');
      expect(await storage.list(`artwork/${orgs.alpha}/${original.artworkId}`)).toHaveLength(8);
      await expect(
        editArtwork(sql, storage, alpha(), original.artworkId, edit(original)),
      ).rejects.toMatchObject({ code: 'version_conflict' });
    }, 30_000);

    it('refuses cross-tenant reads/edits and invalid dimensions before writing files', async () => {
      const original = await upload(34);
      const before = await storage.list(`artwork/${orgs.alpha}/${original.artworkId}`);
      await expect(loadCurrentArtwork(sql, beta(), original.artworkId)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(
        editArtwork(sql, storage, beta(), original.artworkId, edit(original)),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        editArtwork(sql, storage, alpha(), original.artworkId, { ...edit(original), widthMm: -1 }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(await storage.list(`artwork/${orgs.alpha}/${original.artworkId}`)).toEqual(before);
    });

    // Same concurrent pipeline cost as the test above.
    it('reports concurrent duplicate edits and removes their staged assets', async () => {
      const originals = [await upload(35), await upload(36)];
      let arrivals = 0;
      let release!: () => void;
      const bothStaged = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stagedStorage: Storage = {
        ...storage,
        put: async (...args) => {
          if (++arrivals === 2) release();
          await bothStaged;
          return storage.put(...args);
        },
      };
      const results = await Promise.allSettled(
        originals.map((original) =>
          editArtwork(sql, stagedStorage, alpha(), original.artworkId, {
            ...edit(original),
            widthMm: 83,
            heightMm: 29,
            rotationDeg: 0,
            flipX: false,
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((result) => result.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason.code).toBe('invalid');
      const keys = await Promise.all(
        originals.map((original) => storage.list(`artwork/${orgs.alpha}/${original.artworkId}`)),
      );
      expect(keys.map((items) => items.length).sort()).toEqual([4, 8]);
    }, 30_000);
  });

  describe('managing the library (F-ART-06)', () => {
    it('renames an artwork without touching what has been placed', async () => {
      const result = await ingestArtwork(sql, storage, alpha(), {
        name: 'Old name',
        source: WORDMARK,
      });
      if (result.status !== 'ready') throw new Error('ingest failed');

      await renameArtwork(sql, alpha(), result.artwork.artworkId, '  New name  ');

      const [found] = (await listArtworks(sql, alpha())).filter(
        (artwork) => artwork.artworkId === result.artwork.artworkId,
      );
      expect(found?.name).toBe('New name');
      // The version a design would have pinned is the same one.
      expect(found?.versionId).toBe(result.artwork.versionId);
    });

    it('refuses an empty name', async () => {
      const result = await ingestArtwork(sql, storage, alpha(), { name: 'Named', source: SQUARE });
      if (result.status !== 'ready') throw new Error('ingest failed');

      await expect(renameArtwork(sql, alpha(), result.artwork.artworkId, '   ')).rejects.toThrow(
        /needs a name/,
      );
    });

    it('is not another organisation’s artwork to rename or delete', async () => {
      const result = await ingestArtwork(sql, storage, alpha(), { name: 'Mine', source: WORDMARK });
      if (result.status !== 'ready') throw new Error('ingest failed');

      await expect(
        renameArtwork(sql, beta(), result.artwork.artworkId, 'Theirs'),
      ).rejects.toThrow();
      await expect(deleteArtwork(sql, beta(), result.artwork.artworkId)).rejects.toThrow();
    });

    it('takes it back when the same file is uploaded again', async () => {
      const first = await ingestArtwork(sql, storage, alpha(), {
        name: 'Returning',
        source: SQUARE,
      });
      if (first.status !== 'ready') throw new Error('ingest failed');
      await deleteArtwork(sql, alpha(), first.artwork.artworkId);

      const again = await ingestArtwork(sql, storage, alpha(), {
        name: 'Returning',
        source: SQUARE,
      });
      expect(again.status).toBe('ready');
      if (again.status !== 'ready') return;

      // The same artwork, restored: the assets never went anywhere, and a fresh row would have
      // collided with the dedupe index.
      expect(again.artwork.artworkId).toBe(first.artwork.artworkId);
      expect((await listArtworks(sql, alpha())).map((a) => a.artworkId)).toContain(
        first.artwork.artworkId,
      );
    });

    it('refuses while a design still places it, and says how many', async () => {
      const result = await ingestArtwork(sql, storage, alpha(), {
        name: 'In use',
        source: WORDMARK,
      });
      if (result.status !== 'ready') throw new Error('ingest failed');

      // A design placing it, written directly: what is under test is the refusal, not the editor.
      await withStaff(sql, async (tx) => {
        const [variant] = await tx`select id from product_variants limit 1`;
        if (!variant) return;
        const designId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        await tx`
          insert into designs (id, org_id, name, product_variant_id)
          values (${designId}, ${orgs.alpha}, 'uses it', ${variant['id']})`;
        await tx`
          insert into design_versions (id, design_id, org_id, version, schema_version, document)
          values (${versionId}, ${designId}, ${orgs.alpha}, 1, 1, ${tx.json({
            placements: [{ artwork: { versionId: result.artwork.versionId } }],
          } as never)})`;
        await tx`update designs set current_version_id = ${versionId} where id = ${designId}`;
      });

      const packsImported = await withStaff(
        sql,
        (tx) => tx`select 1 from product_variants limit 1`,
      );
      if (packsImported.length === 0) return; // no catalog in this database; nothing to place on

      await expect(deleteArtwork(sql, alpha(), result.artwork.artworkId)).rejects.toThrow(
        /1 design still uses/,
      );
    });

    it('deletes an artwork nothing is using', async () => {
      const result = await ingestArtwork(sql, storage, alpha(), { name: 'Unused', source: SQUARE });
      if (result.status !== 'ready') throw new Error('ingest failed');

      await deleteArtwork(sql, alpha(), result.artwork.artworkId);

      const remaining = await listArtworks(sql, alpha());
      expect(remaining.map((artwork) => artwork.artworkId)).not.toContain(result.artwork.artworkId);
    });

    it('describes the contours it derived', async () => {
      const result = await ingestArtwork(sql, storage, alpha(), {
        name: 'Outlined',
        source: SQUARE,
      });
      if (result.status !== 'ready') throw new Error('ingest failed');

      const key = `artwork/${orgs.alpha}/${result.artwork.artworkId}/${result.artwork.versionId}/contours.json`;
      const stored = JSON.parse(new TextDecoder().decode((await storage.get(key)).bytes)) as {
        mmPerPx: number;
        contours: { points: [number, number][]; closed: boolean }[];
      };

      expect(stored.mmPerPx).toBeCloseTo(result.artwork.mmPerPx, 6);
      expect(stored.contours.length).toBeGreaterThan(0);
      expect(stored.contours[0]!.points.length).toBeGreaterThan(3);
    });
  });
});
