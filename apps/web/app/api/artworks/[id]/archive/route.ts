import { NextResponse } from 'next/server';
import { ArtworkEdit } from '@pr/design-schema';
import { artworkArchiveUsage, setArtworkArchived } from '@pr/artworks';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

type Params = { params: Promise<{ id: string }> };

async function readId(params: Params['params']) {
  const { id } = await params;
  if (!ArtworkEdit.shape.versionId.safeParse(id).success) throw new HttpError(404, 'not_found');
  return id;
}

export const GET = route('artworks/:id/archive', async (_request: Request, { params }: Params) => {
  const ctx = await requireTenant();
  return NextResponse.json(await artworkArchiveUsage(getSql(), ctx, await readId(params)));
});

export const POST = route('artworks/:id/archive', async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  return NextResponse.json(await setArtworkArchived(getSql(), ctx, await readId(params), true));
});

export const DELETE = route(
  'artworks/:id/archive',
  async (request: Request, { params }: Params) => {
    assertSameOrigin(request);
    const ctx = await requireTenant();
    return NextResponse.json(await setArtworkArchived(getSql(), ctx, await readId(params), false));
  },
);
