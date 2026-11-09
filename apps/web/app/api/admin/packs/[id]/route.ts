import { NextResponse } from 'next/server';
import {
  setPackStatus,
  setPackVisibility,
  OrientationEditError,
  type PackStatus,
} from '@pr/catalog';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** Publishing, deprecating, and deciding who can see a pack (F-ADM-03). */
export const runtime = 'nodejs';

const STATUSES: PackStatus[] = ['draft', 'published', 'deprecated'];

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;
  const body = (await request.json()) as { status?: string; visibleToOrgIds?: unknown };

  if (body.status) {
    if (!STATUSES.includes(body.status as PackStatus))
      throw new HttpError(422, 'invalid', 'unknown status');
    try {
      return NextResponse.json(
        await setPackStatus(getSql(), id, body.status as PackStatus, principal.userId),
      );
    } catch (error) {
      if (error instanceof OrientationEditError)
        throw new HttpError(422, error.code, error.message);
      throw error;
    }
  }

  if (Array.isArray(body.visibleToOrgIds)) {
    const orgIds = body.visibleToOrgIds.filter(
      (value): value is string => typeof value === 'string',
    );
    return NextResponse.json(await setPackVisibility(getSql(), id, orgIds, principal.userId));
  }

  throw new HttpError(422, 'invalid', 'nothing to change');
}

export const PATCH = route('admin/packs/:id', handlePatch);
