import { NextResponse } from 'next/server';
import { setMemberRole, setMemberStatus } from '@pr/admin';
import { authorize } from '@pr/auth';
import { assertSameOrigin } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { actorFor, requireOwner } from '@/lib/server/org';

/**
 * One member of my own organisation: suspend, reinstate, change role (F-ORG-02).
 *
 * Three checks, none of them redundant. `requireOwner` says this account may administer *an*
 * organisation; `authorize` says it may take *this* action; and the operation itself runs under
 * `withTenant`, so row-level security decides which rows exist at all. The first two are policy and
 * the third is the backstop for the day somebody forgets one of them.
 *
 * There is no DELETE. Suspension is reversible and keeps the person's work, and it is what an owner
 * needs; removing an account outright stays with staff.
 */
export const runtime = 'nodejs';

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireOwner();
  authorize(principal, 'member.remove', { orgId: principal.orgId });

  const { id } = await params;
  const body = (await request.json()) as { status?: string; role?: string };
  const actor = actorFor(principal);

  if (body.role !== undefined) {
    // Only the two roles an owner may hand out. `staff` is rejected here and again in the
    // operation — an owner minting staff would be a privilege escalation, so it is refused twice.
    if (body.role !== 'owner' && body.role !== 'member') {
      throw new HttpError(422, 'invalid', 'role must be owner or member');
    }
    return NextResponse.json(await setMemberRole(getSql(), actor, id, body.role));
  }

  if (body.status === 'active' || body.status === 'suspended') {
    return NextResponse.json(await setMemberStatus(getSql(), actor, id, body.status));
  }

  throw new HttpError(422, 'invalid', 'nothing to change');
}

export const PATCH = route('org/members/:id', handlePatch);
