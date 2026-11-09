import { NextResponse } from 'next/server';
import { draftPack, meshPath, type DraftOptions } from '@pr/cad';
import { getIngestion } from '@pr/cad-jobs';
import { importPack, PackImportError } from '@pr/catalog';
import { contentTypeFor } from '@pr/storage';
import { currentLog } from '@pr/observability';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';

/**
 * Turning a finished ingestion into a draft Product Pack (F-GEN-02, docs/23 stage 10).
 *
 * The last stage of ingestion and the first of authoring, and deliberately the *existing* importer:
 * there is one code path into the catalog and this feeds it, rather than being a second one. What
 * comes out is a draft with no zones, which the zone authoring step already knows how to finish.
 *
 * Everything geometry cannot answer for itself comes from the request: what the product is called,
 * what category it belongs in, what a variant is. Nothing here guesses at those, because a pack
 * that named itself would be a pack somebody published without reading.
 */
export const runtime = 'nodejs';

interface DraftBody {
  packKey?: string;
  packName?: string;
  version?: string;
  productKey?: string;
  productName?: string;
  category?: string;
  variantKey?: string;
  variantName?: string;
  /** Preview only: report what would be created and write nothing. */
  dryRun?: boolean;
}

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as DraftBody;
  const options = requireOptions(body);

  const job = await getIngestion(getSql(), { orgId: principal.orgId, userId: principal.userId }, id);
  if (job.status !== 'succeeded' || !job.result) {
    throw new HttpError(409, 'conflict', `this ingestion is ${job.status}; there is nothing to draft from yet`);
  }

  const { manifest, todos } = draftPack(job.result, options);

  if (body.dryRun) return NextResponse.json({ manifest, todos, dryRun: true });

  const storage = getStorage();
  // The manifest names paths inside the pack; the meshes are sitting in the ingestion's staging
  // prefix. This is the one place that knows both, which is why the mapping lives here rather than
  // in the drafter — a drafter that knew about storage keys would be a drafter that needed
  // credentials.
  const staged = new Map(job.result.meshes.map((mesh) => [meshPath(options, mesh.fileName), mesh]));

  try {
    const result = await importPack(getSql(), manifest, {
      // Never published from here. A pack with no zones is not a product yet, and publishing is a
      // decision somebody makes after looking at it.
      publish: false,
      createdBy: principal.userId,
      assets: {
        read: async (path) => {
          const mesh = staged.get(path);
          if (!mesh?.storageKey) throw new PackImportError(`the ingestion has no file for ${path}`);
          return (await storage.get(mesh.storageKey)).bytes;
        },
        write: (key, data) => storage.put(key, data, contentTypeFor(key)),
      },
    });

    currentLog().info('pack drafted from cad ingestion', {
      jobId: id,
      packId: result.packId,
      key: result.key,
      version: result.version,
      todos: todos.length,
    });

    return NextResponse.json({ result, todos, manifest }, { status: 201 });
  } catch (error) {
    if (error instanceof PackImportError) throw new HttpError(422, 'pack_not_importable', error.message);
    throw error;
  }
}

/** The fields nothing but a person can supply. Missing one is a 422, not a default. */
function requireOptions(body: DraftBody): DraftOptions {
  const required = ['packKey', 'packName', 'productKey', 'productName', 'category', 'variantKey'] as const;
  for (const field of required) {
    if (!body[field]?.trim()) throw new HttpError(422, 'invalid', `${field} is required`);
  }

  return {
    packKey: body.packKey!.trim(),
    packName: body.packName!.trim(),
    ...(body.version ? { version: body.version.trim() } : {}),
    productKey: body.productKey!.trim(),
    productName: body.productName!.trim(),
    category: body.category!.trim(),
    variantKey: body.variantKey!.trim(),
    ...(body.variantName ? { variantName: body.variantName.trim() } : {}),
  };
}

export const POST = route('admin/cad/:id/pack', handlePost);
