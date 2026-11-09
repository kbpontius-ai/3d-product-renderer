import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, hasDatabase, seedOrganizations, type TestDatabase } from '@pr/db';
import { localStorage, type Storage } from '@pr/storage';
import { decodePng } from '@pr/artwork/png';
import {
  analyzeArtworkPreparation,
  saveArtworkPreparation,
  loadArtworkPreparation,
  loadArtworkVersion,
  ingestArtwork,
  editArtwork,
  deleteArtwork,
} from './service.js';
import type { ArtworkPreparationRecipe } from '@pr/design-schema';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../../../fixtures/artwork/preparation/${name}.svg`, import.meta.url), 'utf8');

describe.skipIf(!hasDatabase)('authoritative preparation and immutable recipes', () => {
  let db: TestDatabase, storage: Storage, root: string, source: string;
  let orgs: { alpha: string; beta: string };
  const alpha = () => ({ orgId: orgs.alpha, userId: null });
  const beta = () => ({ orgId: orgs.beta, userId: null });
  const keys = async () =>
    [...(await storage.list('artwork')), ...(await storage.list('artwork-source'))].sort();
  const selected = async (ids = ['o1', 'o3']): Promise<ArtworkPreparationRecipe> => {
    const analyzed = await analyzeArtworkPreparation(db.sql, storage, alpha(), { source });
    return { ...analyzed.recipe, selected: ids.map((objectId) => ({ objectId, paint: 'both' })) };
  };
  beforeAll(async () => {
    db = await createTestDatabase('pr_preparation_service');
    orgs = await seedOrganizations(db.sql);
    root = await mkdtemp(join(tmpdir(), 'pr-preparation-service-'));
    storage = localStorage(root);
    source = await fixture('monogram');
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('analyzes without persisting a draft, then stores selected visible paint and matching holes', async () => {
    expect(await keys()).toEqual([]);
    const recipe = await selected();
    const draft = await analyzeArtworkPreparation(db.sql, storage, alpha(), { source, recipe });
    expect(draft.preview?.canSave).toBe(true);
    expect(await keys()).toEqual([]);
    const result = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source,
      recipe,
      name: 'Synthetic monogram',
    });
    if (result.status !== 'ready') throw new Error('Expected a prepared mark');
    expect(result.artwork.naturalSizeMm).toEqual({ w: 30, h: 20 });
    expect(result.artwork.selectionEditable).toBe(true);
    const retained = await loadArtworkPreparation(
      db.sql,
      storage,
      alpha(),
      result.artwork.artworkId,
      result.artwork.versionId,
    );
    expect(retained.original).toBe(source);
    expect(retained.recipe).toEqual(recipe);
    const mask = decodePng((await storage.get(result.artwork.maskKey)).bytes);
    const x = 8 + Math.round(5 / result.artwork.mmPerPx),
      y = 8 + Math.round(6 / result.artwork.mmPerPx);
    expect(mask.data[y * mask.width + x]).toBe(0);
    const bytes = new TextDecoder().decode((await storage.get(result.artwork.sourceKey)).bytes);
    expect(bytes).not.toContain('fill="#ffffff"');
    expect(bytes).not.toContain('<style');
  });
  it('retries concurrent identical saves idempotently and keeps different selections distinct', async () => {
    const recipe = await selected(['o3']);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        saveArtworkPreparation(db.sql, storage, alpha(), {
          source,
          recipe,
          name: 'Concurrent variant',
        }),
      ),
    );
    const versions = results.map((result) =>
      result.status === 'ready' ? result.artwork.versionId : null,
    );
    expect(versions.every(Boolean)).toBe(true);
    expect(new Set(versions).size).toBe(1);
    const first = results[0]!;
    if (first.status !== 'ready') throw new Error('Expected a prepared mark');
    expect(
      await storage.list(`artwork-source/${orgs.alpha}/${first.artwork.artworkId}`),
    ).toHaveLength(2);
    const different = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source,
      recipe: await selected(['o1']),
      name: 'Different selection',
    });
    if (different.status !== 'ready') throw new Error('Expected a prepared mark');
    expect(different.artwork.versionId).not.toBe(first.artwork.versionId);
  });
  it('explains an older cached version instead of saving an item the current library cannot show', async () => {
    const original = `<!-- cache regression -->\n${source}`;
    const analysis = await analyzeArtworkPreparation(db.sql, storage, alpha(), {
      source: original,
    });
    const recipe = { ...analysis.recipe, selected: [{ objectId: 'o1', paint: 'both' as const }] };
    const first = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source: original,
      recipe,
      name: 'Synthetic cached version',
    });
    if (first.status !== 'ready') throw new Error('Expected a prepared mark');
    const second = await editArtwork(db.sql, storage, alpha(), first.artwork.artworkId, {
      versionId: first.artwork.versionId,
      name: first.artwork.name,
      widthMm: 40,
      heightMm: 40,
      rotationDeg: 0,
      flipX: false,
      flipY: false,
    });
    if (second.status !== 'ready') throw new Error('Expected an edited mark');
    await expect(
      saveArtworkPreparation(db.sql, storage, alpha(), {
        source: original,
        recipe,
        name: 'Retry old preparation',
      }),
    ).rejects.toThrow(/older version.*Edit selection/);
    const current = await loadArtworkPreparation(
      db.sql,
      storage,
      alpha(),
      first.artwork.artworkId,
      second.artwork.versionId,
    );
    expect(current.recipe.transforms).toHaveLength(1);
    const restored = await saveArtworkPreparation(db.sql, storage, alpha(), {
      artworkId: first.artwork.artworkId,
      versionId: second.artwork.versionId,
      recipe,
      name: second.artwork.name,
    });
    if (restored.status !== 'ready') throw new Error('Expected explicit cached selection');
    expect(restored.artwork.versionId).toBe(first.artwork.versionId);
    await deleteArtwork(db.sql, alpha(), first.artwork.artworkId);
    const reuploaded = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source: original,
      recipe,
      name: 'Restore cached version',
    });
    if (reuploaded.status !== 'ready') throw new Error('Expected restored current artwork');
    expect(reuploaded.artwork.versionId).toBe(first.artwork.versionId);
    const editedAgain = await editArtwork(db.sql, storage, alpha(), first.artwork.artworkId, {
      versionId: first.artwork.versionId,
      name: first.artwork.name,
      widthMm: 40,
      heightMm: 40,
      rotationDeg: 0,
      flipX: false,
      flipY: false,
    });
    if (editedAgain.status !== 'ready') throw new Error('Expected edited version');
    await deleteArtwork(db.sql, alpha(), first.artwork.artworkId);
    const restoredOlder = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source: original,
      recipe,
      name: 'Restore selected original',
    });
    if (restoredOlder.status !== 'ready')
      throw new Error('Expected explicitly restored older version');
    expect(restoredOlder.artwork.versionId).toBe(first.artwork.versionId);
    await loadArtworkPreparation(
      db.sql,
      storage,
      alpha(),
      first.artwork.artworkId,
      first.artwork.versionId,
    );
  });
  it('preserves recoverable choices and pinned assets through consecutive whole-artwork edits', async () => {
    const first = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source,
      recipe: await selected(),
      name: 'Synthetic monogram',
    });
    if (first.status !== 'ready') throw new Error('Expected a prepared mark');
    const original = first.artwork;
    const pinned = (await storage.get(original.sourceKey)).bytes;
    const edit = {
      versionId: original.versionId,
      name: 'Edited monogram',
      widthMm: 60,
      heightMm: 40,
      rotationDeg: 90,
      flipX: true,
      flipY: false,
    };
    const second = await editArtwork(db.sql, storage, alpha(), original.artworkId, edit);
    if (second.status !== 'ready') throw new Error('Expected an edited mark');
    const retained = await loadArtworkPreparation(
      db.sql,
      storage,
      alpha(),
      original.artworkId,
      second.artwork.versionId,
    );
    expect(retained.recipe.transforms).toHaveLength(1);
    expect(retained.recipe.selected.map((item) => item.objectId)).toEqual(['o1', 'o3']);
    expect(second.artwork.naturalSizeMm.w).toBeCloseTo(40, 4);
    expect(second.artwork.naturalSizeMm.h).toBeCloseTo(60, 4);
    const third = await editArtwork(db.sql, storage, alpha(), original.artworkId, {
      ...edit,
      versionId: second.artwork.versionId,
      widthMm: 20,
      heightMm: 30,
      rotationDeg: 0,
      flipX: false,
    });
    if (third.status !== 'ready') throw new Error('Expected an edited mark');
    expect(
      (
        await loadArtworkPreparation(
          db.sql,
          storage,
          alpha(),
          original.artworkId,
          third.artwork.versionId,
        )
      ).recipe.transforms,
    ).toHaveLength(2);
    expect((await storage.get(original.sourceKey)).bytes).toEqual(pinned);
    expect(await loadArtworkVersion(db.sql, alpha(), original.versionId)).toMatchObject({
      versionId: original.versionId,
      naturalSizeMm: original.naturalSizeMm,
    });
    const reopened = await analyzeArtworkPreparation(db.sql, storage, alpha(), {
      artworkId: original.artworkId,
      versionId: third.artwork.versionId,
    });
    expect(reopened.recipe.transforms).toHaveLength(2);
  });
  it('enforces source identity, tenant isolation, unsupported inputs, and version conflicts', async () => {
    const first = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source,
      recipe: await selected(['o1']),
      name: 'Different selection',
    });
    if (first.status !== 'ready') throw new Error('Expected a prepared mark');
    const artwork = first.artwork;
    await expect(
      analyzeArtworkPreparation(db.sql, storage, beta(), {
        artworkId: artwork.artworkId,
        versionId: artwork.versionId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      saveArtworkPreparation(db.sql, storage, alpha(), {
        source,
        recipe: { ...(await selected()), sourceDigest: '0'.repeat(64) },
        name: 'Wrong file',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      saveArtworkPreparation(db.sql, storage, alpha(), {
        artworkId: artwork.artworkId,
        versionId: '11111111-1111-4111-8111-111111111111',
        recipe: await selected(['o0']),
        name: 'Outdated',
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const before = await keys();
    await expect(
      analyzeArtworkPreparation(db.sql, storage, alpha(), {
        source: await fixture('unsupported-effects'),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await keys()).toEqual(before);
  });
  it('reuploads an original into a new legacy artwork version without altering the old version', async () => {
    const legacy = await ingestArtwork(db.sql, storage, alpha(), {
      source:
        '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>',
      name: 'Legacy square',
    });
    if (legacy.status !== 'ready') throw new Error('Expected a legacy mark');
    const old = (await storage.get(legacy.artwork.sourceKey)).bytes;
    const prepared = await saveArtworkPreparation(db.sql, storage, alpha(), {
      source,
      recipe: await selected(['o0']),
      name: 'Prepared replacement',
      artworkId: legacy.artwork.artworkId,
      versionId: legacy.artwork.versionId,
    });
    if (prepared.status !== 'ready') throw new Error('Expected a prepared mark');
    expect(prepared.artwork.artworkId).toBe(legacy.artwork.artworkId);
    expect(prepared.artwork.versionId).not.toBe(legacy.artwork.versionId);
    expect(prepared.artwork.selectionEditable).toBe(true);
    expect((await storage.get(legacy.artwork.sourceKey)).bytes).toEqual(old);
  });
});
