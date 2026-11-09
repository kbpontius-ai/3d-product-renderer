import { NextResponse } from 'next/server';
import { ArtworkEdit } from '@pr/design-schema';
import { artworkForClient } from '@/lib/server/artworks';
import { getStorage } from '@/lib/server/storage';
import { enforceLimit } from '@/lib/server/limits';
import { deleteArtwork, editArtwork, loadCurrentArtwork, renameArtwork } from '@pr/artworks';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { HttpError, problem } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

export const runtime = 'nodejs';

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  const { id } = await params;
  if (!ArtworkEdit.shape.versionId.safeParse(id).success) throw new HttpError(404, 'not_found');

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = ArtworkEdit.shape.name.safeParse(body?.name);
  if (!name.success) throw new HttpError(422, 'invalid', 'a name is needed');

  await renameArtwork(getSql(), ctx, id, name.data);
  return new NextResponse(null, { status: 204 });
}

async function handleDelete(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  const { id } = await params;
  if (!ArtworkEdit.shape.versionId.safeParse(id).success) throw new HttpError(404, 'not_found');

  await deleteArtwork(getSql(), ctx, id);
  return new NextResponse(null, { status: 204 });
}

export const PATCH = route('artworks/:id', handlePatch);
export const DELETE = route('artworks/:id', handleDelete);

async function handleGet(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenant();
  const { id } = await params;
  if (!ArtworkEdit.shape.versionId.safeParse(id).success) throw new HttpError(404, 'not_found');
  const artwork = await loadCurrentArtwork(getSql(), ctx, id);
  return NextResponse.json(artworkForClient(artwork, ctx.userId ?? ctx.orgId));
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  const { id } = await params;
  if (!ArtworkEdit.shape.versionId.safeParse(id).success) throw new HttpError(404, 'not_found');
  const parsed = ArtworkEdit.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    throw new HttpError(422, 'invalid', 'Check the name, dimensions and rotation.');
  await enforceLimit('artworkUpload', ctx.userId ?? ctx.orgId);
  const result = await editArtwork(getSql(), getStorage(), ctx, id, parsed.data);
  if (result.status === 'rejected') return problem('artwork_rejected', 422, result.report);
  return NextResponse.json(artworkForClient(result.artwork, ctx.userId ?? ctx.orgId));
}

export const GET = route('artworks/:id', handleGet);
export const PUT = route('artworks/:id', handlePut);
