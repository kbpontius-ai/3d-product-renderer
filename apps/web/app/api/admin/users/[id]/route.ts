import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteUser, setUserRole, setUserStatus, type Role } from '@pr/admin';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** One account: suspend, restore, change role, remove (F-ADM-06). */
export const runtime = 'nodejs';

function organizationContext(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get('orgId');
  if (value === null) return undefined;
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(422, 'invalid', 'invalid organization');
  return parsed.data;
}

const ROLES: Role[] = ['staff', 'owner', 'member'];

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;
  const orgId = organizationContext(request);
  const body = (await request.json()) as { status?: string; role?: string };

  if (body.role) {
    if (!ROLES.includes(body.role as Role)) throw new HttpError(422, 'invalid', 'unknown role');
    return NextResponse.json(
      await setUserRole(getSql(), id, body.role as Role, principal.userId, orgId),
    );
  }

  if (body.status === 'active' || body.status === 'suspended') {
    return NextResponse.json(
      await setUserStatus(getSql(), id, body.status, principal.userId, orgId),
    );
  }

  throw new HttpError(422, 'invalid', 'nothing to change');
}

async function handleDelete(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;
  const orgId = organizationContext(request);

  await deleteUser(getSql(), id, principal.userId, orgId);
  return new NextResponse(null, { status: 204 });
}

export const PATCH = route('admin/users/:id', handlePatch);
export const DELETE = route('admin/users/:id', handleDelete);
