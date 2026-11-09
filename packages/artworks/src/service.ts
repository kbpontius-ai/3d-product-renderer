import { ArtworkError, lockArtworkUsage, assertArtworkActive } from './archive.js';
export { ArtworkError } from './archive.js';
import { createHash } from 'node:crypto';
import { uuidv7, withTenant, type Sql, type Tx, type TenantContext } from '@pr/db';
import {
  ArtworkEdit,
  canonicalArtworkPreparationRecipe,
  type ArtworkPreparationRecipe,
  type ArtworkPreparationRequest,
  type ArtworkReport,
} from '@pr/design-schema';
import { encodeFieldTo16, signedDistanceFieldMm } from '@pr/artwork';
import { encodeGray16Png, encodeGray8Png } from '@pr/artwork/png';
import {
  choosePitchMm,
  rasterizeArtwork,
  transformArtworkSvg,
  previewArtworkPreparation,
} from '@pr/raster';
import {
  PIPELINE_VERSION,
  DEFAULT_MAX_BYTES,
  prepareArtwork,
  normalizeSvg,
  sanitizeSvg,
  analyzeArtworkSource,
  PreparationError,
} from '@pr/svg';
import { traceContours } from '@pr/artwork';
import { contentTypeFor, type Storage } from '@pr/storage';

/**
 * Artwork ingest (W-04, build order D1/D5/D6).
 *
 * The whole pipeline runs here, server-side: sanitise, normalise, validate, rasterise, distance
 * field, store. The editor ran the same pure functions in the tab while there was nowhere to put
 * the result; now that there is, the browser stops being the only place a customer's logo exists.
 *
 * Rejections are not stored. An SVG the pipeline refuses never becomes a row, a file or an id — the
 * caller gets the report and nothing else changes.
 */

/** Distance field detail: fine enough for a crisp bevel, small enough to serve quickly. */
const MAX_SIDE_PX = 3072;

export interface ArtworkRecord {
  artworkId: string;
  versionId: string;
  name: string;
  naturalSizeMm: { w: number; h: number };
  mmPerPx: number;
  widthPx: number;
  heightPx: number;
  sdfRangeMm: [number, number];
  stats: { coverage: number; minStrokeMm: number | null };
  /** Storage keys. The mask becomes a URL the browser fetches; the field is for the renderer. */
  sourceKey: string;
  maskKey: string;
  sdfKey: string;
  report: ArtworkReport;
  createdAt: string;
  selectionEditable: boolean;
  archivedAt: string | null;
}

export interface ArtworkPreparationSource {
  original: string;
  editableSvg: string;
  recipe: ArtworkPreparationRecipe;
}

export type IngestResult =
  | { status: 'ready'; artwork: ArtworkRecord; reused: boolean }
  | { status: 'rejected'; report: ArtworkReport };

export async function ingestArtwork(
  sql: Sql,
  storage: Storage,
  ctx: TenantContext,
  input: {
    name: string;
    source: string;
    update?: { artworkId: string; versionId: string };
    preparation?: ArtworkPreparationSource;
  },
): Promise<IngestResult> {
  const preparation = input.preparation && {
    ...input.preparation,
    recipe: canonicalArtworkPreparationRecipe(input.preparation.recipe),
  };
  if (
    preparation &&
    (Buffer.byteLength(preparation.original, 'utf8') > DEFAULT_MAX_BYTES ||
      Buffer.byteLength(preparation.editableSvg, 'utf8') > 8 * 1024 * 1024)
  ) {
    throw new ArtworkError(
      'too_large',
      'The source or editable drawing exceeds the preparation limit. Export a simpler SVG.',
    );
  }
  if (
    preparation &&
    createHash('sha256').update(preparation.original, 'utf8').digest('hex') !==
      preparation.recipe.sourceDigest
  ) {
    throw new ArtworkError('invalid', 'The selection belongs to a different source file.');
  }
  const digest = createHash('sha256')
    .update(
      preparation ? `prepared-artwork\n${JSON.stringify(preparation.recipe)}` : input.source,
      'utf8',
    )
    .digest();

  // The same bytes through the same pipeline produce the same assets, so re-uploading a logo
  // returns the version that already exists rather than paying for it twice.
  const existing = await findByDigest(sql, ctx, digest, !input.update && !preparation);
  if (existing) {
    if (!input.update) {
      if (preparation)
        return {
          status: 'ready',
          artwork: await reusePreparedVersion(sql, ctx, existing),
          reused: true,
        };
      return { status: 'ready', artwork: existing, reused: true };
    }
    if (existing.artworkId !== input.update.artworkId) {
      throw new ArtworkError(
        'invalid',
        'These edits match another artwork already in your library.',
      );
    }
    if (preparation) {
      const current = await loadCurrentArtwork(sql, ctx, input.update.artworkId);
      if (current.versionId === existing.versionId && current.name === input.name)
        return { status: 'ready', artwork: current, reused: true };
    }
    await withTenant(sql, ctx, async (tx) => {
      await lockArtworkUsage(tx, ctx.orgId);
      await lockArtwork(tx, input.update!);
      await tx`update artworks set name = ${input.name}, current_version_id = ${existing.versionId}
               where id = ${existing.artworkId}`;
    });
    return { status: 'ready', artwork: { ...existing, name: input.name }, reused: true };
  }

  const prepared = prepareArtwork(input.source);
  if (prepared.status === 'rejected' || !prepared.artwork || !prepared.svg) {
    return { status: 'rejected', report: prepared.report };
  }

  const longestSideMm = Math.max(
    prepared.report.stats.contentBbox.w,
    prepared.report.stats.contentBbox.h,
  );
  const raster = rasterizeArtwork(prepared.artwork, {
    mmPerPx: choosePitchMm(longestSideMm),
    maxSidePx: MAX_SIDE_PX,
  });
  if (!raster) {
    return {
      status: 'rejected',
      report: {
        ...prepared.report,
        status: 'rejected',
        errors: [
          ...prepared.report.errors,
          { code: 'empty_after_normalize', message: 'This file has no visible artwork to place.' },
        ],
      },
    };
  }

  const field = signedDistanceFieldMm(raster.mask, raster.mmPerPx);
  const encoded = encodeFieldTo16(field);

  const artworkId = input.update?.artworkId ?? uuidv7();
  const versionId = uuidv7();
  const prefix = `artwork/${ctx.orgId}/${artworkId}/${versionId}`;
  const maskKey = `${prefix}/mask.png`;
  const originalKey = preparation
    ? `artwork-source/${ctx.orgId}/${artworkId}/${versionId}/original.bin`
    : null;
  const editableKey = preparation
    ? `artwork-source/${ctx.orgId}/${artworkId}/${versionId}/editable.svg`
    : null;

  const assets: [kind: string, key: string, bytes: Uint8Array][] = [
    ['sanitized', `${prefix}/sanitized.svg`, new TextEncoder().encode(prepared.svg)],
    [
      'mask',
      maskKey,
      encodeGray8Png(raster.mask.data, raster.mask.width, raster.mask.height, [
        { key: 'mmPerPx', value: String(raster.mmPerPx) },
        { key: 'Software', value: `3d-product-renderer artwork pipeline ${PIPELINE_VERSION}` },
      ]),
    ],
    [
      'sdf',
      `${prefix}/sdf.png`,
      encodeGray16Png(encoded.data, field.width, field.height, [
        { key: 'mmPerPx', value: String(raster.mmPerPx) },
        { key: 'sdfRangeMm', value: `${encoded.range[0]},${encoded.range[1]}` },
      ]),
    ],
    [
      // Where the artwork's edge runs, in millimetres: the face view outlines it, clearance is
      // measured from it, and the v2 spec sheet dimensions it. Derived once, here, so nothing
      // downstream has to re-derive it from pixels and get a slightly different answer.
      'contours',
      `${prefix}/contours.json`,
      new TextEncoder().encode(
        JSON.stringify({
          mmPerPx: raster.mmPerPx,
          contours: traceContours(raster.mask, raster.mmPerPx),
        }),
      ),
    ],
  ];

  const sourceAssets: [string, Uint8Array][] = preparation
    ? [
        [originalKey!, new TextEncoder().encode(preparation.original)],
        [editableKey!, new TextEncoder().encode(preparation.editableSvg)],
      ]
    : [];

  // Files first: a row pointing at bytes that are not there yet is the failure mode worth avoiding,
  // and an orphaned file is cheap to sweep.

  const record: ArtworkRecord = {
    artworkId,
    versionId,
    name: input.name,
    naturalSizeMm: raster.contentSizeMm,
    mmPerPx: raster.mmPerPx,
    widthPx: field.width,
    heightPx: field.height,
    sdfRangeMm: [encoded.range[0]!, encoded.range[1]!],
    stats: {
      coverage: prepared.report.stats.coverage,
      minStrokeMm: prepared.report.stats.minStrokeMm,
    },
    sourceKey: `${prefix}/sanitized.svg`,
    maskKey,
    sdfKey: `${prefix}/sdf.png`,
    report: prepared.report,
    createdAt: new Date().toISOString(),
    selectionEditable: Boolean(preparation),
    archivedAt: null,
  };

  try {
    for (const [, key, bytes] of assets) await storage.put(key, bytes, contentTypeFor(key));
    for (const [key, bytes] of sourceAssets) await storage.put(key, bytes, contentTypeFor(key));
    await withTenant(sql, ctx, async (tx) => {
      await lockArtworkUsage(tx, ctx.orgId);
      let version = 1;
      if (input.update) {
        const current = await lockArtwork(tx, input.update);
        record.createdAt = (current['created_at'] as Date).toISOString();
        const [latest] =
          await tx`select max(version)::int as version from artwork_versions where artwork_id = ${artworkId}`;
        version = Number(latest?.['version'] ?? 0) + 1;
        await tx`update artworks set name = ${input.name} where id = ${artworkId}`;
      } else {
        const [inserted] = await tx`
          insert into artworks (id, org_id, name, created_by)
          values (${artworkId}, ${ctx.orgId}, ${input.name}, ${ctx.userId}) returning created_at`;
        record.createdAt = (inserted!['created_at'] as Date).toISOString();
      }
      await tx`
      insert into artwork_versions
        (id, artwork_id, org_id, version, status, source_key, digest, pipeline_version,
         natural_size_mm, bbox, report, original_key, editable_key, preparation_recipe)
      values
        (${versionId}, ${artworkId}, ${ctx.orgId}, ${version}, 'ready', ${`${prefix}/sanitized.svg`},
         ${digest}, ${PIPELINE_VERSION},
         ${sql.json({ ...raster.contentSizeMm, mmPerPx: raster.mmPerPx } as never)},
         ${sql.json({
           widthPx: field.width,
           heightPx: field.height,
           sdfRangeMm: record.sdfRangeMm,
         } as never)},
         ${sql.json(prepared.report as never)}, ${originalKey}, ${editableKey},
         ${preparation ? sql.json(preparation.recipe as never) : null})`;
      await tx`update artworks set current_version_id = ${versionId} where id = ${artworkId}`;

      for (const [kind, key] of assets) {
        await tx`
        insert into artwork_assets (id, artwork_version_id, org_id, kind, storage_key)
        values (${uuidv7()}, ${versionId}, ${ctx.orgId}, ${kind}, ${key})`;
      }
    });
  } catch (error) {
    await Promise.all(
      [...assets.map(([, key]) => key), ...sourceAssets.map(([key]) => key)].map((key) =>
        storage.delete(key),
      ),
    );
    const duplicate =
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint_name' in error &&
      error.constraint_name === 'artwork_versions_dedupe_idx';
    if (
      preparation &&
      (duplicate || (error instanceof ArtworkError && error.code === 'version_conflict'))
    ) {
      const winner = await findByDigest(sql, ctx, digest, false);
      if (winner && !input.update)
        return {
          status: 'ready',
          artwork: await reusePreparedVersion(sql, ctx, winner),
          reused: true,
        };
      if (winner && input.update && winner.artworkId === input.update.artworkId) {
        const current = await loadCurrentArtwork(sql, ctx, winner.artworkId);
        if (current.versionId === winner.versionId && current.name === input.name)
          return { status: 'ready', artwork: current, reused: true };
      }
    }
    if (
      input.update &&
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint_name' in error &&
      error.constraint_name === 'artwork_versions_dedupe_idx'
    ) {
      throw new ArtworkError(
        'invalid',
        'These edits match another artwork already in your library.',
      );
    }
    throw error;
  }

  return { status: 'ready', artwork: record, reused: false };
}

export async function loadArtworkVersion(
  sql: Sql,
  ctx: TenantContext,
  versionId: string,
): Promise<ArtworkRecord> {
  const record = await findVersion(sql, ctx, versionId);
  if (!record) throw new ArtworkError('not_found');
  return record;
}

/** The organisation's artwork library, newest first. */
export async function listArtworks(
  sql: Sql,
  ctx: TenantContext,
  limit: number | null = null,
  state: 'active' | 'archived' = 'active',
): Promise<ArtworkRecord[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select a.id, a.name, a.created_at, a.archived_at, v.id as version_id, v.source_key, v.natural_size_mm, v.bbox, v.report,
             v.preparation_recipe is not null as selection_editable,
             (select storage_key from artwork_assets
              where artwork_version_id = v.id and kind = 'mask') as mask_key,
             (select storage_key from artwork_assets
              where artwork_version_id = v.id and kind = 'sdf') as sdf_key
      from artworks a
      join artwork_versions v on v.id = a.current_version_id
      where a.deleted_at is null and v.status = 'ready'
        and ((a.archived_at is not null) = ${state === 'archived'})
      order by a.created_at desc
      limit ${limit}`;
    return rows.map(toRecord);
  });
}

// -----------------------------------------------------------------------------------------------

async function findVersion(
  sql: Sql,
  ctx: TenantContext,
  versionId: string,
): Promise<ArtworkRecord | null> {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await tx`
      select a.id, a.name, a.created_at, a.archived_at, v.id as version_id, v.source_key, v.natural_size_mm, v.bbox, v.report,
             v.preparation_recipe is not null as selection_editable,
             (select storage_key from artwork_assets
              where artwork_version_id = v.id and kind = 'mask') as mask_key,
             (select storage_key from artwork_assets
              where artwork_version_id = v.id and kind = 'sdf') as sdf_key
      from artwork_versions v
      join artworks a on a.id = v.artwork_id
      where v.id = ${versionId} and a.deleted_at is null and v.status = 'ready'`;
    return row ? toRecord(row) : null;
  });
}

async function reusePreparedVersion(
  sql: Sql,
  ctx: TenantContext,
  version: ArtworkRecord,
): Promise<ArtworkRecord> {
  return withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    const [current] =
      await tx`select current_version_id, name, deleted_at, archived_at from artworks where id = ${version.artworkId} for update`;
    if (!current) throw new ArtworkError('not_found');
    if (current['archived_at'])
      throw new ArtworkError(
        'archived_artwork',
        'Restore this artwork before uploading or editing it again.',
        [{ artworkId: version.artworkId, name: current['name'] as string }],
      );
    if (!current['deleted_at'] && current['current_version_id'] !== version.versionId)
      throw new ArtworkError(
        'version_conflict',
        'This preparation matches an older version of artwork in your library. Open the current artwork and use Edit selection to save these choices as its next version. Your upload choices are still here.',
      );
    await tx`update artworks set deleted_at = null, current_version_id = ${version.versionId}
      where id = ${version.artworkId} and deleted_at is not null`;
    return { ...version, name: current['name'] as string };
  });
}

async function findByDigest(
  sql: Sql,
  ctx: TenantContext,
  digest: Buffer,
  restore = true,
): Promise<ArtworkRecord | null> {
  return withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    const [row] = await tx`
      select a.id, a.name, a.created_at, a.deleted_at, a.archived_at, v.id as version_id, v.source_key, v.natural_size_mm, v.bbox,
             v.report, v.preparation_recipe is not null as selection_editable,
             (select storage_key from artwork_assets
              where artwork_version_id = v.id and kind = 'mask') as mask_key,
             (select storage_key from artwork_assets
              where artwork_version_id = v.id and kind = 'sdf') as sdf_key
      from artwork_versions v
      join artworks a on a.id = v.artwork_id
      where v.digest = ${digest} and v.pipeline_version = ${PIPELINE_VERSION}
        and v.status = 'ready'`;

    if (!row) return null;
    if (row['archived_at'])
      throw new ArtworkError(
        'archived_artwork',
        `“${row['name']}” is archived. Restore it in Artwork before uploading or editing it again.`,
        [{ artworkId: row['id'] as string, name: row['name'] as string }],
      );

    // Deleted, and being uploaded again: the derived assets are still in storage and the work was
    // already paid for, so this is a restore rather than a fresh ingest. Refusing here — or
    // inserting — would fail on the dedupe index, which is how this was found.
    if (restore && row['deleted_at']) {
      await tx`update artworks set deleted_at = null where id = ${row['id']}`;
    }
    return toRecord(row);
  });
}

function toRecord(row: Record<string, unknown>): ArtworkRecord {
  const size = row['natural_size_mm'] as { w: number; h: number; mmPerPx: number };
  const bbox = row['bbox'] as { widthPx: number; heightPx: number; sdfRangeMm: [number, number] };
  const report = row['report'] as ArtworkReport;

  return {
    artworkId: row['id'] as string,
    versionId: row['version_id'] as string,
    name: row['name'] as string,
    naturalSizeMm: { w: size.w, h: size.h },
    mmPerPx: size.mmPerPx,
    widthPx: bbox.widthPx,
    heightPx: bbox.heightPx,
    sdfRangeMm: bbox.sdfRangeMm,
    stats: { coverage: report.stats.coverage, minStrokeMm: report.stats.minStrokeMm },
    sourceKey: row['source_key'] as string,
    maskKey: row['mask_key'] as string,
    sdfKey: row['sdf_key'] as string,
    report,
    createdAt: (row['created_at'] as Date).toISOString(),
    selectionEditable: Boolean(row['selection_editable']),
    archivedAt: row['archived_at'] ? (row['archived_at'] as Date).toISOString() : null,
  };
}

/**
 * Renaming (F-ART-06).
 *
 * The name is a label on the library, not part of the artwork: designs reference a version id, so
 * a rename changes nothing about what has already been placed or rendered.
 */
export async function renameArtwork(
  sql: Sql,
  ctx: TenantContext,
  artworkId: string,
  name: string,
): Promise<void> {
  const clean = name.trim().slice(0, 200);
  if (!clean) throw new ArtworkError('invalid', 'an artwork needs a name');

  await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    await assertArtworkActive(tx, artworkId);
    await tx`update artworks set name = ${clean} where id = ${artworkId}`;
  });
}

/**
 * Removing an artwork from the library.
 *
 * Soft, and refused while a design still places it: the design would otherwise render a missing
 * file, hours later, on someone else's machine. The count comes back with the refusal so the
 * person can go and look at them.
 */
export async function deleteArtwork(
  sql: Sql,
  ctx: TenantContext,
  artworkId: string,
): Promise<void> {
  await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    const [artwork] = await tx`
      select id from artworks where id = ${artworkId} and deleted_at is null`;
    if (!artwork) throw new ArtworkError('not_found', 'no such artwork');

    const [used] = await tx`
      select count(*)::int as n
      from designs d
      join design_versions dv on dv.id = d.current_version_id
      where d.deleted_at is null
        and exists (
          select 1 from jsonb_array_elements(dv.document -> 'placements') as placement
          join artwork_versions av on av.id = (placement -> 'artwork' ->> 'versionId')::uuid
          where av.artwork_id = ${artworkId}
        )`;

    const count = Number(used?.['n'] ?? 0);
    if (count > 0) {
      throw new ArtworkError(
        'in_use',
        `${count} design${count === 1 ? '' : 's'} still use this artwork`,
      );
    }

    await tx`update artworks set deleted_at = now() where id = ${artworkId}`;
  });
}

async function lockArtwork(tx: Tx, update: { artworkId: string; versionId: string }) {
  await assertArtworkActive(tx, update.artworkId);
  const [row] = await tx`select current_version_id, created_at from artworks
    where id = ${update.artworkId} and deleted_at is null for update`;
  if (!row) throw new ArtworkError('not_found');
  if (row['current_version_id'] !== update.versionId) {
    throw new ArtworkError(
      'version_conflict',
      'This artwork changed while you were editing. Reopen it before saving.',
    );
  }
  return row;
}

export async function loadCurrentArtwork(
  sql: Sql,
  ctx: TenantContext,
  artworkId: string,
): Promise<ArtworkRecord> {
  const versionId = await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    const [row] =
      await tx`select current_version_id from artworks where id = ${artworkId} and deleted_at is null`;
    return row?.['current_version_id'] as string | undefined;
  });
  if (!versionId) throw new ArtworkError('not_found');
  return loadArtworkVersion(sql, ctx, versionId);
}

export async function loadArtworkPreparation(
  sql: Sql,
  storage: Storage,
  ctx: TenantContext,
  artworkId: string,
  versionId: string,
): Promise<ArtworkPreparationSource> {
  const current = await loadCurrentArtwork(sql, ctx, artworkId);
  if (current.archivedAt)
    throw new ArtworkError('archived_artwork', 'Restore this artwork before editing it.');
  if (current.versionId !== versionId) {
    throw new ArtworkError(
      'version_conflict',
      'This artwork changed. Reopen it before editing its selection.',
    );
  }
  const row = await withTenant(sql, ctx, async (tx) => {
    await lockArtworkUsage(tx, ctx.orgId);
    const [source] = await tx`select original_key, editable_key, preparation_recipe
      from artwork_versions where id = ${versionId} and artwork_id = ${artworkId}`;
    return source;
  });
  if (!row?.['original_key'] || !row['editable_key'] || !row['preparation_recipe']) {
    throw new ArtworkError(
      'invalid',
      'Original file needed to edit selection. Reupload the original SVG to prepare a new version.',
    );
  }
  const [original, editable] = await Promise.all([
    storage.get(row['original_key'] as string),
    storage.get(row['editable_key'] as string),
  ]);
  const source = {
    original: new TextDecoder().decode(original.bytes),
    editableSvg: new TextDecoder().decode(editable.bytes),
    recipe: canonicalArtworkPreparationRecipe(
      row['preparation_recipe'] as ArtworkPreparationRecipe,
    ),
  };
  if (
    createHash('sha256').update(source.original, 'utf8').digest('hex') !==
    source.recipe.sourceDigest
  ) {
    throw new ArtworkError(
      'invalid',
      'The retained source is unavailable or damaged. Reupload your original file.',
    );
  }
  return source;
}

export async function editArtwork(
  sql: Sql,
  storage: Storage,
  ctx: TenantContext,
  artworkId: string,
  input: ArtworkEdit,
): Promise<IngestResult> {
  const parsed = ArtworkEdit.safeParse(input);
  if (!parsed.success)
    throw new ArtworkError('invalid', 'Check the name, dimensions and rotation.');
  const edit = parsed.data;
  const current = await loadCurrentArtwork(sql, ctx, artworkId);
  if (current.archivedAt)
    throw new ArtworkError('archived_artwork', 'Restore this artwork before editing it.');
  if (current.versionId !== edit.versionId)
    throw new ArtworkError('version_conflict', 'This artwork changed. Reopen it before saving.');
  const unchanged =
    edit.widthMm === current.naturalSizeMm.w &&
    edit.heightMm === current.naturalSizeMm.h &&
    edit.rotationDeg === 0 &&
    !edit.flipX &&
    !edit.flipY;
  if (unchanged) {
    await withTenant(sql, ctx, async (tx) => {
      await lockArtworkUsage(tx, ctx.orgId);
      await lockArtwork(tx, { artworkId, versionId: edit.versionId });
      await tx`update artworks set name = ${edit.name} where id = ${artworkId}`;
    });
    return { status: 'ready', artwork: { ...current, name: edit.name }, reused: true };
  }
  if (current.selectionEditable) {
    const preparation = await loadArtworkPreparation(sql, storage, ctx, artworkId, edit.versionId);
    if (preparation.recipe.transforms.length >= 50)
      throw new ArtworkError(
        'invalid',
        'This artwork has reached its transform history limit. Re-export the prepared mark to start a new artwork.',
      );
    const recipe = {
      ...preparation.recipe,
      transforms: [
        ...preparation.recipe.transforms,
        {
          widthMm: edit.widthMm,
          heightMm: edit.heightMm,
          rotationDeg: edit.rotationDeg,
          flipX: edit.flipX,
          flipY: edit.flipY,
        },
      ],
    };
    return saveArtworkPreparation(sql, storage, ctx, {
      artworkId,
      versionId: edit.versionId,
      name: edit.name,
      recipe,
    });
  }
  const stored = await storage.get(current.sourceKey);
  const normalized = normalizeSvg(sanitizeSvg(new TextDecoder().decode(stored.bytes)).root);
  const source = transformArtworkSvg(normalized, edit);
  return ingestArtwork(sql, storage, ctx, {
    name: edit.name,
    source,
    update: { artworkId, versionId: edit.versionId },
  });
}

async function resolvePreparationSource(
  sql: Sql,
  storage: Storage,
  ctx: TenantContext,
  input: ArtworkPreparationRequest,
) {
  const current = input.artworkId ? await loadCurrentArtwork(sql, ctx, input.artworkId) : null;
  if (current?.archivedAt)
    throw new ArtworkError('archived_artwork', 'Restore this artwork before editing it.');
  if (current && current.versionId !== input.versionId) {
    if (input.recipe) {
      const digest = createHash('sha256')
        .update(
          `prepared-artwork\n${JSON.stringify(canonicalArtworkPreparationRecipe(input.recipe))}`,
        )
        .digest();
      const existing = await findByDigest(sql, ctx, digest, false);
      if (!existing || existing.versionId !== current.versionId || current.name !== input.name)
        throw new ArtworkError(
          'version_conflict',
          'This artwork changed. Reload it or save your choices as a separate artwork.',
        );
    } else
      throw new ArtworkError(
        'version_conflict',
        'This artwork changed. Reload it before editing selection.',
      );
  }
  const retained =
    input.source === undefined && current
      ? await loadArtworkPreparation(sql, storage, ctx, current.artworkId, current.versionId)
      : null;
  const source = input.source ?? retained?.original;
  if (!source)
    throw new ArtworkError(
      'invalid',
      'Choose an SVG file or reopen an existing source-backed artwork.',
    );
  return {
    source,
    name: input.name ?? current?.name ?? 'Artwork',
    recipe: input.recipe ?? retained?.recipe,
  };
}

export async function analyzeArtworkPreparation(
  sql: Sql,
  storage: Storage,
  ctx: TenantContext,
  input: ArtworkPreparationRequest,
) {
  const resolved = await resolvePreparationSource(sql, storage, ctx, input);
  try {
    const analysis = await analyzeArtworkSource(resolved.source);
    const recipe = resolved.recipe ?? {
      sourceDigest: analysis.sourceDigest,
      analyzerVersion: analysis.analyzerVersion,
      selected: [],
      repairs: [],
      acknowledged: [],
      transforms: [],
    };
    return {
      analysis,
      recipe,
      name: resolved.name,
      preview: input.recipe ? previewArtworkPreparation(analysis, recipe) : null,
    };
  } catch (error) {
    if (error instanceof PreparationError) throw new ArtworkError('invalid', error.message);
    throw error;
  }
}

export async function saveArtworkPreparation(
  sql: Sql,
  storage: Storage,
  ctx: TenantContext,
  input: ArtworkPreparationRequest,
): Promise<IngestResult> {
  if (!input.recipe || !input.name)
    throw new ArtworkError('invalid', 'Confirm the selection and a name before saving.');
  const resolved = await resolvePreparationSource(sql, storage, ctx, input);
  try {
    const analysis = await analyzeArtworkSource(resolved.source);
    const preview = previewArtworkPreparation(analysis, input.recipe);
    if (!preview.canSave || !preview.svg)
      throw new ArtworkError(
        'invalid',
        preview.issues
          .filter(
            (issue) =>
              issue.severity === 'error' ||
              (issue.severity === 'review' && !preview.recipe.acknowledged.includes(issue.id)),
          )
          .map((issue) => issue.message)
          .join(' ') || 'Keep visible artwork before saving.',
      );
    return ingestArtwork(sql, storage, ctx, {
      name: input.name,
      source: preview.svg,
      ...(input.artworkId && input.versionId
        ? { update: { artworkId: input.artworkId, versionId: input.versionId } }
        : {}),
      preparation: {
        original: resolved.source,
        editableSvg: preview.sourceSvg,
        recipe: preview.recipe,
      },
    });
  } catch (error) {
    if (error instanceof PreparationError) throw new ArtworkError('invalid', error.message);
    throw error;
  }
}
