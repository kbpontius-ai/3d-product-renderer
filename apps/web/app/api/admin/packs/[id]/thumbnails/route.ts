import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listThumbnailVariants, saveCatalogThumbnail, ThumbnailError } from '@pr/catalog';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { getStorage, sharedAssetUrl } from '@/lib/server/storage';
import { HttpError } from '@/lib/server/http';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
async function handleGet(_request: Request, { params }: Context) {
  await requireStaff();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'not_found');
  const variants = await listThumbnailVariants(getSql(), id);
  if (!variants.length) throw new HttpError(404, 'not_found');
  return NextResponse.json(
    variants.map(({ meshKey, thumbnailKey, ...variant }) => ({
      ...variant,
      meshUrl: meshKey ? sharedAssetUrl(meshKey) : null,
      thumbnailUrl: thumbnailKey ? sharedAssetUrl(thumbnailKey) : null,
    })),
  );
}
async function handlePut(request: Request, { params }: Context) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  await enforceLimit('thumbnail', principal.userId);
  const { id } = await params;
  const variantId = new URL(request.url).searchParams.get('variantId');
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(variantId).success)
    throw new HttpError(422, 'invalid', 'Choose a product variant.');
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'image/png')
    throw new HttpError(415, 'unsupported_type', 'A preview must be a PNG.');
  // Bound the body before decoding it: the capture canvas always produces a small image.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(422, 'invalid', 'The image was empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new HttpError(413, 'too_large', 'The preview is larger than 2 MB.');
    }
    chunks.push(value);
  }
  const png = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const key = await saveCatalogThumbnail(getSql(), getStorage(), {
      packId: id,
      variantId: variantId!,
      png,
      actorId: principal.userId,
    });
    return NextResponse.json({ thumbnailUrl: sharedAssetUrl(key) });
  } catch (error) {
    if (error instanceof ThumbnailError)
      throw new HttpError(error.code === 'not_found' ? 404 : 422, error.code, error.message);
    throw error;
  }
}
export const GET = route('admin/packs/:id/thumbnails', handleGet);
export const PUT = route('admin/packs/:id/thumbnails', handlePut);
