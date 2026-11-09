import { NextResponse } from 'next/server';
import { ArtworkEdit } from '@pr/design-schema';
import { loadArtworkPreparation, loadCurrentArtwork } from '@pr/artworks';
import { requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { getStorage } from '@/lib/server/storage';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

async function handleGet(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenant();
  const { id } = await params;
  const versionId = new URL(request.url).searchParams.get('versionId');
  if (
    !ArtworkEdit.shape.versionId.safeParse(id).success ||
    !ArtworkEdit.shape.versionId.safeParse(versionId).success
  )
    throw new HttpError(404, 'not_found');
  const current = await loadCurrentArtwork(getSql(), ctx, id);
  const retained = await loadArtworkPreparation(getSql(), getStorage(), ctx, id, versionId!);
  return new NextResponse(new TextEncoder().encode(retained.original), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="artwork.svg"; filename*=UTF-8''${encodeURIComponent(current.name + '.svg')}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'no-store',
    },
  });
}

export const GET = route('artworks/:id/original', handleGet);
