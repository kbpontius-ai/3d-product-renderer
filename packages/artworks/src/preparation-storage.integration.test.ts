import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, hasDatabase, seedOrganizations, type TestDatabase } from '@pr/db';
import { localStorage, type Storage } from '@pr/storage';
import type { ArtworkPreparationRecipe } from '@pr/design-schema';
import {
  ingestArtwork,
  loadArtworkPreparation,
  loadCurrentArtwork,
  type ArtworkPreparationSource,
} from './service.js';

const source =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12mm" height="12mm" viewBox="0 0 12 12"><rect width="12" height="12"/></svg>';
const recipe = (): ArtworkPreparationRecipe => ({
  sourceDigest: createHash('sha256').update(source).digest('hex'),
  analyzerVersion: '1',
  selected: [{ objectId: 'o1', paint: 'fill' }],
  repairs: [],
  acknowledged: [],
  transforms: [],
});
const preparation = (): ArtworkPreparationSource => ({
  original: source,
  editableSvg: source,
  recipe: recipe(),
});

describe.skipIf(!hasDatabase)('source-backed artwork persistence', () => {
  let db: TestDatabase;
  let storage: Storage;
  let root: string;
  let orgs: { alpha: string; beta: string };
  const alpha = () => ({ orgId: orgs.alpha, userId: null });
  const beta = () => ({ orgId: orgs.beta, userId: null });
  beforeAll(async () => {
    db = await createTestDatabase('pr_prepared_artwork');
    orgs = await seedOrganizations(db.sql);
    root = await mkdtemp(join(tmpdir(), 'pr-prepared-artwork-'));
    storage = localStorage(root);
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('retains original bytes and canonical choices separately from the placed source', async () => {
    const result = await ingestArtwork(db.sql, storage, alpha(), {
      name: 'Synthetic square',
      source,
      preparation: preparation(),
    });
    if (result.status !== 'ready') throw new Error('Expected a valid mark');
    expect(result.artwork.selectionEditable).toBe(true);
    expect(
      (await loadCurrentArtwork(db.sql, alpha(), result.artwork.artworkId)).selectionEditable,
    ).toBe(true);
    const retained = await loadArtworkPreparation(
      db.sql,
      storage,
      alpha(),
      result.artwork.artworkId,
      result.artwork.versionId,
    );
    expect(retained).toEqual(preparation());
    expect((await storage.list(`artwork-source/${orgs.alpha}`)).sort()).toEqual([
      `artwork-source/${orgs.alpha}/${result.artwork.artworkId}/${result.artwork.versionId}/editable.svg`,
      `artwork-source/${orgs.alpha}/${result.artwork.artworkId}/${result.artwork.versionId}/original.bin`,
    ]);
    const original = await storage.get(
      `artwork-source/${orgs.alpha}/${result.artwork.artworkId}/${result.artwork.versionId}/original.bin`,
    );
    expect(original.contentType).toBe('application/octet-stream');
    await expect(
      loadArtworkPreparation(
        db.sql,
        storage,
        beta(),
        result.artwork.artworkId,
        result.artwork.versionId,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('deduplicates canonical recipes while preserving different selections as different versions', async () => {
    const data = preparation();
    data.recipe.selected.push({ objectId: 'o2', paint: 'stroke' });
    const first = await ingestArtwork(db.sql, storage, alpha(), {
      name: 'Variant',
      source,
      preparation: data,
    });
    if (first.status !== 'ready') throw new Error('Expected a valid mark');
    data.recipe.selected.reverse();
    const same = await ingestArtwork(db.sql, storage, alpha(), {
      name: 'Same variant',
      source,
      preparation: data,
    });
    if (same.status !== 'ready') throw new Error('Expected a valid mark');
    expect(same.reused).toBe(true);
    expect(same.artwork.versionId).toBe(first.artwork.versionId);
    data.recipe.selected[0]!.paint = 'fill';
    const changed = await ingestArtwork(db.sql, storage, alpha(), {
      name: 'Different choice',
      source,
      preparation: data,
    });
    if (changed.status !== 'ready') throw new Error('Expected a valid mark');
    expect(changed.reused).toBe(false);
    expect(changed.artwork.versionId).not.toBe(first.artwork.versionId);
  });
  it('refuses wrong-source recipes and offers an original-file recovery for legacy versions', async () => {
    const data = preparation();
    data.recipe.sourceDigest = '0'.repeat(64);
    const before = await storage.list(`artwork-source/${orgs.alpha}`);
    await expect(
      ingestArtwork(db.sql, storage, alpha(), { name: 'Wrong source', source, preparation: data }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await storage.list(`artwork-source/${orgs.alpha}`)).toEqual(before);
    const legacy = await ingestArtwork(db.sql, storage, alpha(), { name: 'Legacy square', source });
    if (legacy.status !== 'ready') throw new Error('Expected a valid mark');
    expect(legacy.artwork.selectionEditable).toBe(false);
    await expect(
      loadArtworkPreparation(
        db.sql,
        storage,
        alpha(),
        legacy.artwork.artworkId,
        legacy.artwork.versionId,
      ),
    ).rejects.toThrow('Original file needed');
  });
  it('cleans staged private source files after a rejected concurrent version save', async () => {
    const first = await ingestArtwork(db.sql, storage, alpha(), {
      name: 'Conflict',
      source,
      preparation: preparation(),
    });
    if (first.status !== 'ready') throw new Error('Expected a valid mark');
    const before = await storage.list(`artwork-source/${orgs.alpha}/${first.artwork.artworkId}`);
    const data = preparation();
    data.recipe.repairs = [{ kind: 'stroke-width', objectId: 'o1', widthMm: 2 }];
    await expect(
      ingestArtwork(db.sql, storage, alpha(), {
        name: 'Outdated choice',
        source,
        preparation: data,
        update: {
          artworkId: first.artwork.artworkId,
          versionId: '11111111-1111-4111-8111-111111111111',
        },
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await storage.list(`artwork-source/${orgs.alpha}/${first.artwork.artworkId}`)).toEqual(
      before,
    );
  });
});
