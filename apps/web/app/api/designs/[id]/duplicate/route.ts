import { NextResponse } from 'next/server';
import { duplicateDesign } from '@pr/designs';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { handleRouteError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** "Try a variation without losing this one" — the copy starts at version 1 of its own history. */
async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const ctx = await requireTenant();
    const { id } = await params;
    return NextResponse.json(await duplicateDesign(getSql(), ctx, id), { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = route('designs/:id/duplicate', handlePost);
