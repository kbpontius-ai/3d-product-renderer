import { NextResponse } from 'next/server';
import { createDraftVersion, PackImportError } from '@pr/catalog';
import { contentTypeFor } from '@pr/storage';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';

/**
 * A new draft version of a pack, copied from this one (F-ADM-13).
 *
 * The way a published pack's zones are changed: the published version stays exactly as customers'
 * designs know it, and the copy is where zones are added, moved and removed.
 */
export const runtime = 'nodejs';

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const storage = getStorage();
  try {
    const result = await createDraftVersion(
      getSql(),
      id,
      {
        read: async (key) => (await storage.get(key)).bytes,
        write: (key, bytes) => storage.put(key, bytes, contentTypeFor(key)),
      },
      principal.userId,
    );
    return NextResponse.json({ packId: result.packId, version: result.version }, { status: 201 });
  } catch (error) {
    if (error instanceof PackImportError) throw new HttpError(422, 'invalid', error.message);
    throw error;
  }
}

export const POST = route('admin/packs/:id/versions', handlePost);
