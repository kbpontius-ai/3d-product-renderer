import { NextResponse } from 'next/server';
import { MaterialError, setMaterialTexture } from '@pr/catalog';
import { contentTypeFor } from '@pr/storage';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';

/**
 * Uploading a texture into a material slot (F-ADM-04).
 *
 * The image is stored like any other asset and the material's definition points at the storage key
 * — the same key the preview fetches and the worker downloads, so a texture uploaded here is
 * already the one both renderers will use.
 */
export const runtime = 'nodejs';

const SLOTS = ['baseColor', 'roughness', 'metallic', 'normal', 'ao', 'height'] as const;
const MAX_BYTES = 32 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const slot = new URL(request.url).searchParams.get('slot') ?? '';
  if (!SLOTS.includes(slot as (typeof SLOTS)[number])) throw new HttpError(422, 'invalid', 'unknown texture slot');

  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!ALLOWED.has(contentType)) throw new HttpError(415, 'unsupported_type', 'PNG, JPEG or WebP only');

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new HttpError(422, 'invalid', 'the upload was empty');
  if (bytes.byteLength > MAX_BYTES) throw new HttpError(413, 'too_large', 'that texture is too large');

  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const key = `materials/${id}/${slot}-${Date.now().toString(36)}.${extension}`;
  await getStorage().put(key, bytes, contentTypeFor(key));

  try {
    const material = await setMaterialTexture(
      getSql(),
      id,
      slot as (typeof SLOTS)[number],
      key,
      principal.userId,
    );
    return NextResponse.json(material, { status: 201 });
  } catch (error) {
    if (error instanceof MaterialError) throw new HttpError(404, error.code, error.message);
    throw error;
  }
}

async function handleDelete(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const slot = new URL(request.url).searchParams.get('slot') ?? '';
  if (!SLOTS.includes(slot as (typeof SLOTS)[number])) throw new HttpError(422, 'invalid', 'unknown texture slot');

  // The stored file is left alone: an older material version may still point at it, and storage is
  // cheaper than a design that renders with a missing map.
  return NextResponse.json(
    await setMaterialTexture(getSql(), id, slot as (typeof SLOTS)[number], null, principal.userId),
  );
}

export const POST = route('admin/materials/:id/texture', handlePost);
export const DELETE = route('admin/materials/:id/texture', handleDelete);
