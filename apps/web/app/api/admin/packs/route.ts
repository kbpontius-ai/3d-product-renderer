import { NextResponse } from 'next/server';
import { importPack, listPacks, packVersionStatus, PackImportError } from '@pr/catalog';
import { readPackArchive, ZipError } from '@pr/packfile';
import { contentTypeFor } from '@pr/storage';
import { currentLog } from '@pr/observability';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';

/**
 * Pack ingestion through the browser (F-ADM-01, F-GEN-02).
 *
 * The upload is a zip: a manifest and the files it names, which is what a pack is. It is read,
 * validated and reported on before anything is written — `x-dry-run` returns exactly what the
 * import would do, so publishing is never the first time anyone sees the problems.
 *
 * The same importer runs as the CLI uses. There is one code path into the catalog, and this is a
 * different way of feeding it rather than a second one.
 */
export const runtime = 'nodejs';

/** Large enough for a real pack with meshes and textures, small enough to bound the memory. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

async function handleGet() {
  await requireStaff();
  return NextResponse.json({ packs: await listPacks(getSql()) });
}

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  await enforceLimit('packUpload', principal.userId);

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'that archive is too big');

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new HttpError(422, 'invalid', 'the upload was empty');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'that archive is too big');

  let archive;
  try {
    archive = readPackArchive(bytes);
  } catch (error) {
    if (error instanceof ZipError) throw new HttpError(422, 'invalid_archive', error.message);
    throw error;
  }

  const preview = {
    key: archive.manifest?.key ?? null,
    version: archive.manifest?.version ?? null,
    name: archive.manifest?.name ?? null,
    products: archive.manifest?.products.length ?? 0,
    variants: archive.manifest?.products.reduce((n, p) => n + p.variants.length, 0) ?? 0,
    zones:
      archive.manifest?.products.reduce(
        (n, p) => n + p.variants.reduce((m, v) => m + v.zones.length, 0),
        0,
      ) ?? 0,
    materials: archive.manifest?.materials.length ?? 0,
    issues: archive.issues,
    missing: archive.missing,
    unused: archive.unused,
    publishable: archive.publishable && archive.missing.length === 0,
    // Said before anything is written: a published version with different contents will be refused,
    // and a draft will be replaced.
    existing:
      archive.manifest?.key && archive.manifest.version
        ? await packVersionStatus(getSql(), archive.manifest.key, archive.manifest.version)
        : null,
  };

  if (request.headers.get('x-dry-run') === 'true') return NextResponse.json({ preview });

  if (!preview.publishable) {
    throw new HttpError(422, 'pack_not_importable', 'fix the problems listed before importing');
  }

  const storage = getStorage();
  try {
    const result = await importPack(getSql(), archive.raw, {
      publish: request.headers.get('x-publish') === 'true',
      createdBy: principal.userId,
      assets: {
        read: async (path) => {
          const file = archive.files.get(path);
          if (!file) throw new PackImportError(`the archive does not contain ${path}`);
          return file;
        },
        write: (key, data) => storage.put(key, data, contentTypeFor(key)),
      },
    });

    currentLog().info('pack imported', {
      key: result.key,
      version: result.version,
      status: result.status,
      products: result.products,
    });
    return NextResponse.json({ preview, result }, { status: 201 });
  } catch (error) {
    if (error instanceof PackImportError) {
      throw new HttpError(422, 'pack_not_importable', error.message);
    }
    throw error;
  }
}

export const GET = route('admin/packs', handleGet);
export const POST = route('admin/packs', handlePost);
