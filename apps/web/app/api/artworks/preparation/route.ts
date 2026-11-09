import { NextResponse } from 'next/server';
import { analyzeArtworkPreparation, saveArtworkPreparation } from '@pr/artworks';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { getStorage } from '@/lib/server/storage';
import { artworkForClient } from '@/lib/server/artworks';
import { readArtworkPreparationRequest } from '@/lib/server/artwork-preparation-request';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';
import { problem } from '@/lib/server/http';

export const runtime = 'nodejs';

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  await enforceLimit('artworkPrepare', ctx.userId ?? ctx.orgId);
  const input = await readArtworkPreparationRequest(request);
  return NextResponse.json(await analyzeArtworkPreparation(getSql(), getStorage(), ctx, input));
}

async function handlePut(request: Request) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  await enforceLimit('artworkUpload', ctx.userId ?? ctx.orgId);
  const input = await readArtworkPreparationRequest(request);
  const result = await saveArtworkPreparation(getSql(), getStorage(), ctx, input);
  if (result.status === 'rejected') return problem('artwork_rejected', 422, result.report);
  return NextResponse.json(artworkForClient(result.artwork, ctx.userId ?? ctx.orgId), {
    status: result.reused ? 200 : 201,
  });
}

export const POST = route('artworks/preparation', handlePost);
export const PUT = route('artworks/preparation', handlePut);
