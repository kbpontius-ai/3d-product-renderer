import { NextResponse } from 'next/server';
import { setPackAccess } from '@pr/admin';
import { authorize } from '@pr/auth';
import { assertSameOrigin } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { actorFor, requireOwner } from '@/lib/server/org';

/**
 * Grant or withhold one product for one member (F-ORG-03).
 *
 * The write is the small half. What makes this safe is that the read it affects is enforced in
 * row-level security on `product_packs` — so a member whose access is withheld cannot reach the
 * product by typing its URL, which is the failure mode of every access control that lives only in
 * a page that decides what to draw.
 */
export const runtime = 'nodejs';

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireOwner();
  authorize(principal, 'member.remove', { orgId: principal.orgId });

  const { id } = await params;
  const body = (await request.json()) as { packId?: string; allowed?: boolean };

  if (typeof body.packId !== 'string' || body.packId.length === 0) {
    throw new HttpError(422, 'invalid', 'packId is required');
  }
  if (typeof body.allowed !== 'boolean') {
    throw new HttpError(422, 'invalid', 'allowed must be true or false');
  }

  await setPackAccess(getSql(), actorFor(principal), id, body.packId, body.allowed);
  return new NextResponse(null, { status: 204 });
}

export const PUT = route('org/members/:id/access', handlePut);
