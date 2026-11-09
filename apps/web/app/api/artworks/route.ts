import { NextResponse } from 'next/server';
import { artworkForClient } from '@/lib/server/artworks';
import { ingestArtwork, listArtworks } from '@pr/artworks';
import { DEFAULT_MAX_BYTES } from '@pr/svg';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { handleRouteError, HttpError, problem } from '@/lib/server/http';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';

/**
 * The artwork library (W-04, build order D1/D6).
 *
 * Upload is a plain POST of the file's bytes rather than multipart: there is exactly one file and
 * one name, and the name travels in a header. The pipeline runs here, not in the browser, so what a
 * customer uploads is sanitised before it is ever stored — and the browser never has to be trusted
 * to have done it.
 */

export const runtime = 'nodejs';

/**
 * Uploading artwork (F-ART-01): a size cap checked against the declared length and the actual
 * bytes, and content sniffed rather than trusted — a file is an SVG because it parses as one,
 * not because of what it was called.
 */

const NON_PRINTING = /[\u0000-\u001f\u007f]/g;

function decodeName(raw: string | null): string {
  if (!raw) return 'Artwork';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed encoding is not worth refusing an upload over; the raw value still names it.
  }
  return decoded.replace(NON_PRINTING, '').trim().slice(0, 120) || 'Artwork';
}

async function handleGet(request: Request) {
  try {
    const ctx = await requireTenant();
    const state = new URL(request.url).searchParams.get('state') ?? 'active';
    if (state !== 'active' && state !== 'archived')
      throw new HttpError(422, 'invalid', 'Choose active or archived artwork.');
    const artworks = await listArtworks(getSql(), ctx, null, state);
    return NextResponse.json({
      artworks: artworks.map((artwork) => artworkForClient(artwork, ctx.userId ?? ctx.orgId)),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

async function handlePost(request: Request) {
  try {
    assertSameOrigin(request);
    const ctx = await requireTenant();
    await enforceLimit('artworkUpload', ctx.userId ?? ctx.orgId);

    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > DEFAULT_MAX_BYTES) throw new HttpError(413, 'too_large');

    const source = await request.text();
    if (Buffer.byteLength(source, 'utf8') > DEFAULT_MAX_BYTES)
      throw new HttpError(413, 'too_large');

    // The client percent-encodes the file name, because a header may only carry latin-1 and a
    // customer's logo is as likely to be called "Grün.svg" as anything else.
    const name = decodeName(request.headers.get('x-artwork-name'));

    const result = await ingestArtwork(getSql(), getStorage(), ctx, { name, source });

    // A rejection is an answer, not a failure: the report says what to fix, and 422 is what a
    // caller that is not our editor should see.
    if (result.status === 'rejected') return problem('artwork_rejected', 422, result.report);

    return NextResponse.json(artworkForClient(result.artwork, ctx.userId ?? ctx.orgId), {
      status: result.reused ? 200 : 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = route('artworks', handleGet);
export const POST = route('artworks', handlePost);
