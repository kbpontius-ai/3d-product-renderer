import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withTenant,
  type TestDatabase,
} from '@pr/db';
import { importPack, listProducts } from '@pr/catalog';
import { localStorage, type Storage } from '@pr/storage';
import type { Placement } from '@pr/design-schema';
import { buildRenderSpec } from '../../render-spec/src/index.js';
import {
  createDesign,
  saveDesign,
  loadDesign,
  listDesigns,
  renameDesign,
  duplicateDesign,
  switchVariant,
  setDesignThumbnail,
  deleteDesign,
  restoreDesign,
} from '../../designs/src/service.js';
import { submitRender } from '../../render-jobs/src/queue.js';
import {
  ingestArtwork,
  editArtwork,
  renameArtwork,
  deleteArtwork,
  listArtworks,
  loadArtworkVersion,
  type ArtworkRecord,
} from './service.js';
import { artworkArchiveUsage, lockArtworkUsage, setArtworkArchived } from './archive.js';

describe.skipIf(!hasDatabase)('artwork archive', () => {
  let db: TestDatabase;
  let orgs: { alpha: string; beta: string };
  let storage: Storage;
  let root: string;
  let variantId: string;
  let sequence = 0;
  const alpha = () => ({ orgId: orgs.alpha, userId: null });
  const beta = () => ({ orgId: orgs.beta, userId: null });

  beforeAll(async () => {
    db = await createTestDatabase('pr_archive');
    orgs = await seedOrganizations(db.sql);
    root = await mkdtemp(join(tmpdir(), 'pr-archive-'));
    storage = localStorage(root);
    await importPack(
      db.sql,
      JSON.parse(
        readFileSync(
          new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url),
          'utf8',
        ),
      ),
      { publish: true },
    );
    const products = await listProducts(db.sql, alpha());
    variantId = products.find((item) => item.productKey === 'cap-flat')!.variants[0]!.variantId;
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const source = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10"><path d="M0 0L20 0L${++sequence / 10} 10Z"/></svg>`;
  async function artwork(): Promise<ArtworkRecord> {
    const result = await ingestArtwork(db.sql, storage, alpha(), {
      name: `Archive mark ${sequence}`,
      source: source(),
    });
    if (result.status !== 'ready') throw new Error('fixture artwork was rejected');
    return result.artwork;
  }
  const placement = (item: ArtworkRecord, order = 0): Placement => ({
    id: crypto.randomUUID(),
    zoneKey: 'top',
    artwork: { artworkId: item.artworkId, versionId: item.versionId },
    transform: {
      offsetMm: { x: 0, y: 0 },
      sizeMm: { w: 18, h: 9 },
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      lockAspect: true,
    },
    finish: { kind: 'deboss', depthMm: 0.2, bevelDeg: 20, edgeRadiusMm: 0.05 },
    order,
  });

  it('archives every version, keeps assets and designs intact, and restores without new versions', async () => {
    const first = await artwork();
    const edited = await editArtwork(db.sql, storage, alpha(), first.artworkId, {
      name: first.name,
      versionId: first.versionId,
      widthMm: 20,
      heightMm: 10,
      rotationDeg: 90,
      flipX: false,
      flipY: false,
    });
    if (edited.status !== 'ready') throw new Error('fixture edit failed');
    const oldDesign = await createDesign(db.sql, alpha(), {
      variantId,
      placements: [placement(first)],
    });
    const newDesign = await createDesign(db.sql, alpha(), {
      variantId,
      placements: [placement(edited.artwork)],
    });
    const keys = await storage.list(`artwork/${orgs.alpha}/${first.artworkId}`);
    const bytes = await Promise.all(keys.map(async (key) => (await storage.get(key)).bytes));
    expect(await artworkArchiveUsage(db.sql, alpha(), first.artworkId)).toEqual({ usageCount: 2 });
    const archived = await setArtworkArchived(db.sql, alpha(), first.artworkId, true);
    expect(archived.usageCount).toBe(2);
    expect(await setArtworkArchived(db.sql, alpha(), first.artworkId, true)).toEqual(archived);
    expect((await listArtworks(db.sql, alpha())).some((a) => a.artworkId === first.artworkId)).toBe(
      false,
    );
    expect(
      (await listArtworks(db.sql, alpha(), null, 'archived')).some(
        (a) => a.artworkId === first.artworkId,
      ),
    ).toBe(true);
    expect((await loadArtworkVersion(db.sql, alpha(), first.versionId)).archivedAt).toBe(
      archived.archivedAt,
    );
    for (const design of [oldDesign, newDesign]) {
      const loaded = await loadDesign(db.sql, alpha(), design.id);
      expect(loaded.document).toEqual(design.document);
      expect(loaded.version).toBe(design.version);
      expect(loaded.archivedArtworks).toEqual([{ artworkId: first.artworkId, name: first.name }]);
    }
    expect(
      (await listDesigns(db.sql, alpha())).find((d) => d.id === oldDesign.id)?.archivedArtworks,
    ).toHaveLength(1);
    await expect(deleteArtwork(db.sql, alpha(), first.artworkId)).rejects.toMatchObject({
      code: 'in_use',
    });
    await setArtworkArchived(db.sql, alpha(), first.artworkId, false);
    expect(await setArtworkArchived(db.sql, alpha(), first.artworkId, false)).toEqual({
      archivedAt: null,
      usageCount: 2,
    });
    expect((await loadDesign(db.sql, alpha(), oldDesign.id)).archivedArtworks).toEqual([]);
    expect(await storage.list(`artwork/${orgs.alpha}/${first.artworkId}`)).toEqual(keys);
    for (let i = 0; i < keys.length; i++)
      expect((await storage.get(keys[i]!)).bytes).toEqual(bytes[i]);
  });

  it('rejects removal/replacement, rename, duplicate, variant change, thumbnail writes and new uses', async () => {
    const item = await artwork();
    const design = await createDesign(db.sql, alpha(), {
      variantId,
      placements: [placement(item)],
    });
    await setArtworkArchived(db.sql, alpha(), item.artworkId, true);
    await expect(
      saveDesign(db.sql, alpha(), {
        designId: design.id,
        document: { ...design.document, placements: [] },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'archived_artwork' });
    await expect(renameDesign(db.sql, alpha(), design.id, 'Bypass')).rejects.toMatchObject({
      code: 'archived_artwork',
    });
    await expect(duplicateDesign(db.sql, alpha(), design.id)).rejects.toMatchObject({
      code: 'archived_artwork',
    });
    await expect(switchVariant(db.sql, alpha(), design.id, variantId)).rejects.toMatchObject({
      code: 'archived_artwork',
    });
    let wrote = false;
    await expect(
      setDesignThumbnail(db.sql, alpha(), design.id, 'test.png', async () => {
        wrote = true;
      }),
    ).rejects.toMatchObject({ code: 'archived_artwork' });
    expect(wrote).toBe(false);
    await expect(
      createDesign(db.sql, alpha(), { variantId, placements: [placement(item)] }),
    ).rejects.toMatchObject({ code: 'archived_artwork' });
    const blank = await createDesign(db.sql, alpha(), { variantId });
    await expect(
      saveDesign(db.sql, alpha(), {
        designId: blank.id,
        document: { ...blank.document, placements: [placement(item)] },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'archived_artwork' });
    expect((await loadDesign(db.sql, alpha(), design.id)).document).toEqual(design.document);
  });

  it('blocks artwork edits and identical uploads without silently restoring', async () => {
    const svg = source();
    const result = await ingestArtwork(db.sql, storage, alpha(), { name: 'Dedupe', source: svg });
    if (result.status !== 'ready') throw new Error('fixture rejected');
    const item = result.artwork;
    await setArtworkArchived(db.sql, alpha(), item.artworkId, true);
    await expect(
      ingestArtwork(db.sql, storage, alpha(), { name: 'Again', source: svg }),
    ).rejects.toMatchObject({ code: 'archived_artwork' });
    await expect(renameArtwork(db.sql, alpha(), item.artworkId, 'Renamed')).rejects.toMatchObject({
      code: 'archived_artwork',
    });
    await expect(
      editArtwork(db.sql, storage, alpha(), item.artworkId, {
        name: 'Edit',
        versionId: item.versionId,
        widthMm: 20,
        heightMm: 10,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
      }),
    ).rejects.toMatchObject({ code: 'archived_artwork' });
    expect((await loadArtworkVersion(db.sql, alpha(), item.versionId)).archivedAt).not.toBeNull();
  });

  it('requires restoration of every blocker, including non-first placements', async () => {
    const a = await artwork();
    const b = await artwork();
    const design = await createDesign(db.sql, alpha(), {
      variantId,
      placements: [placement(a), placement(b, 1)],
    });
    await setArtworkArchived(db.sql, alpha(), b.artworkId, true);
    expect((await loadDesign(db.sql, alpha(), design.id)).archivedArtworks).toEqual([
      { artworkId: b.artworkId, name: b.name },
    ]);
    await setArtworkArchived(db.sql, alpha(), a.artworkId, true);
    await setArtworkArchived(db.sql, alpha(), b.artworkId, false);
    await expect(renameDesign(db.sql, alpha(), design.id, 'Still locked')).rejects.toMatchObject({
      code: 'archived_artwork',
    });
    await setArtworkArchived(db.sql, alpha(), a.artworkId, false);
    await renameDesign(db.sql, alpha(), design.id, 'Editable again');
    expect((await loadDesign(db.sql, alpha(), design.id)).name).toBe('Editable again');
  });

  it('does not expose or manage another organisation’s archived files', async () => {
    const item = await artwork();
    await expect(setArtworkArchived(db.sql, beta(), item.artworkId, true)).rejects.toMatchObject({
      code: 'not_found',
    });
    await setArtworkArchived(db.sql, alpha(), item.artworkId, true);
    await expect(setArtworkArchived(db.sql, beta(), item.artworkId, false)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(artworkArchiveUsage(db.sql, beta(), item.artworkId)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await listArtworks(db.sql, beta(), null, 'archived')).toEqual([]);
  });

  it('preserves the lock when a deleted design is restored', async () => {
    const item = await artwork();
    const design = await createDesign(db.sql, alpha(), {
      variantId,
      placements: [placement(item)],
    });
    await setArtworkArchived(db.sql, alpha(), item.artworkId, true);
    await deleteDesign(db.sql, alpha(), design.id);
    await restoreDesign(db.sql, alpha(), design.id);
    expect((await loadDesign(db.sql, alpha(), design.id)).archivedArtworks).toHaveLength(1);
  });

  it('rejects a save waiting behind an archive transaction', async () => {
    const item = await artwork();
    const design = await createDesign(db.sql, alpha(), {
      variantId,
      placements: [placement(item)],
    });
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const archiving = withTenant(db.sql, alpha(), async (tx) => {
      await lockArtworkUsage(tx, orgs.alpha);
      await tx`update artworks set archived_at = now() where id = ${item.artworkId}`;
      locked();
      await finish;
    });
    await acquired;
    const saving = saveDesign(db.sql, alpha(), {
      designId: design.id,
      document: { ...design.document, placements: [] },
      expectedVersion: 1,
    });
    const rejected = expect(saving).rejects.toMatchObject({ code: 'archived_artwork' });
    release();
    await archiving;
    await rejected;
    expect((await loadDesign(db.sql, alpha(), design.id)).version).toBe(1);
  });

  it('rejects new render jobs without changing saved render snapshots', async () => {
    const item = await artwork();
    const design = await createDesign(db.sql, alpha(), {
      variantId,
      placements: [placement(item)],
    });
    const [version] = await withTenant(
      db.sql,
      alpha(),
      (tx) => tx`select current_version_id from designs where id = ${design.id}`,
    );
    const spec = buildRenderSpec({
      document: design.document,
      resolved: {
        meshKey: 'test.glb',
        meshDigest: 'a'.repeat(64),
        bboxMm: [
          [-19, 0, -19],
          [19, 18, 19],
        ],
        zones: [],
        artwork: [],
        materials: [],
        environment: {
          key: 'studio-softbox',
          hdriKey: 'env/softbox.hdr',
          rotationDeg: 0,
          exposureEv: 0,
        },
      },
      outputs: [
        {
          kind: 'image',
          widthPx: 1024,
          heightPx: 1024,
          format: 'png16',
          camera: { kind: 'preset', presetKey: 'three-quarter' },
        },
      ],
      preset: 'draft',
      renderer: { id: 'cycles', version: '4.0.2' },
      seed: 1,
    });
    await setArtworkArchived(db.sql, alpha(), item.artworkId, true);
    await expect(
      submitRender(db.sql, alpha(), {
        designVersionId: version!['current_version_id'] as string,
        spec,
      }),
    ).rejects.toMatchObject({ code: 'archived_artwork' });
    expect((await loadDesign(db.sql, alpha(), design.id)).document).toEqual(design.document);
  });
});
