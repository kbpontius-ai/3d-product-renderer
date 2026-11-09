import { NextResponse } from 'next/server';
import { createDesign, listDesigns } from '@pr/designs';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { handleRouteError, HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/**
 * The design collection (build order G2).
 *
 * A design is always opened against a catalog variant the caller can see: `createDesign` resolves
 * the variant through the same tenant-scoped read the catalog page uses, so an id guessed from
 * another organisation's URL is simply unknown here.
 */

async function handleGet() {
  try {
    const ctx = await requireTenant();
    return NextResponse.json({ designs: await listDesigns(getSql(), ctx) });
  } catch (error) {
    return handleRouteError(error);
  }
}

async function handlePost(request: Request) {
  try {
    assertSameOrigin(request);
    const ctx = await requireTenant();

    const body = (await request.json()) as { variantId?: string; name?: string };
    if (!body.variantId) throw new HttpError(400, 'variant_required');

    const design = await createDesign(getSql(), ctx, {
      variantId: body.variantId,
      ...(body.name ? { name: body.name } : {}),
    });

    return NextResponse.json(design, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = route('designs', handleGet);
export const POST = route('designs', handlePost);
