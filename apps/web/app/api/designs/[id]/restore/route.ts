import { NextResponse } from 'next/server';
import { restoreDesign } from '@pr/designs';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { route } from '@/lib/server/observability';

/** Undoing a deletion, inside the window (F-PROJ-01). */
export const runtime = 'nodejs';

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const ctx = await requireTenant();
  const { id } = await params;

  await restoreDesign(getSql(), ctx, id);
  return new NextResponse(null, { status: 204 });
}

export const POST = route('designs/:id/restore', handlePost);
