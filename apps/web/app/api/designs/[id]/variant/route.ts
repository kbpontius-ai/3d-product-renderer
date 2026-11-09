import { NextResponse } from 'next/server';
import { switchVariant } from '@pr/designs';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** Moving a design between variants of its own product (F-CAT-04). */
export const runtime = 'nodejs';

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  const { id } = await params;

  const body = (await request.json()) as { variantId?: string };
  if (!body.variantId) throw new HttpError(422, 'invalid', 'a variant is needed');

  const result = await switchVariant(getSql(), ctx, id, body.variantId);
  return NextResponse.json({ carried: result.carried, dropped: result.dropped, version: result.version });
}

export const POST = route('designs/:id/variant', handlePost);
