import { NextResponse } from 'next/server';
import { setDesignThumbnail } from '@pr/designs';
import { contentTypeFor } from '@pr/storage';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';

/**
 * The picture of a design (F-PROJ-02).
 *
 * Captured from the editor's own viewport rather than rendered: a dashboard of forty products
 * cannot be forty path-traced images, and what a person recognises is the thing they were just
 * looking at.
 *
 * Overwrites in place under one key per design, so the dashboard never accumulates thumbnails of
 * designs as they used to look.
 */
export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024;

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  const { id } = await params;
  await enforceLimit('thumbnail', ctx.userId ?? ctx.orgId);

  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'image/png') {
    throw new HttpError(415, 'unsupported_type', 'a thumbnail is a PNG');
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new HttpError(422, 'invalid', 'the upload was empty');
  if (bytes.byteLength > MAX_BYTES)
    throw new HttpError(413, 'too_large', 'that thumbnail is too large');
  // A PNG and nothing else: this is written straight to storage and served back to browsers.
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new HttpError(422, 'invalid', 'that is not a PNG');
  }

  const key = `designs/${ctx.orgId}/${id}/thumb.png`;
  await setDesignThumbnail(getSql(), ctx, id, key, () =>
    getStorage().put(key, bytes, contentTypeFor(key)),
  );

  return new NextResponse(null, { status: 204 });
}

export const PUT = route('designs/:id/thumbnail', handlePut);
