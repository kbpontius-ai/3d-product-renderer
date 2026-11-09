import { NextResponse } from 'next/server';
import { getOrganization, setOrgStatus } from '@pr/admin';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** One organisation: read it, or suspend it. Its limits are changed through `/quotas`. */
export const runtime = 'nodejs';

async function handleGet(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  return NextResponse.json(await getOrganization(getSql(), id));
}

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as { status?: string };
  if (body.status !== 'active' && body.status !== 'suspended') {
    // Limits are changed through /quotas: one bill-affecting action, one route, one audit entry.
    throw new HttpError(422, 'invalid', 'only status can be changed here');
  }

  return NextResponse.json(await setOrgStatus(getSql(), id, body.status, principal.userId));
}

export const GET = route('admin/orgs/:id', handleGet);
export const PATCH = route('admin/orgs/:id', handlePatch);
