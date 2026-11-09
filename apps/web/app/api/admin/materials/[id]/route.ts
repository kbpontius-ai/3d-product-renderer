import { NextResponse } from 'next/server';
import { MaterialError, updateMaterial } from '@pr/catalog';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** Editing one material. Changing it changes every design that names it, so staff only. */
export const runtime = 'nodejs';

const STATUSES = ['draft', 'published', 'deprecated'] as const;

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as { name?: string; status?: string; definition?: unknown };
  const patch: { name?: string; status?: (typeof STATUSES)[number]; definition?: unknown } = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
  if (body.status) {
    if (!STATUSES.includes(body.status as (typeof STATUSES)[number])) {
      throw new HttpError(422, 'invalid', 'unknown status');
    }
    patch.status = body.status as (typeof STATUSES)[number];
  }
  if (body.definition !== undefined) patch.definition = body.definition;
  if (Object.keys(patch).length === 0) throw new HttpError(422, 'invalid', 'nothing to change');

  try {
    return NextResponse.json(await updateMaterial(getSql(), id, patch, principal.userId));
  } catch (error) {
    if (error instanceof MaterialError) {
      throw new HttpError(error.code === 'not_found' ? 404 : 422, error.code, error.message);
    }
    throw error;
  }
}

export const PATCH = route('admin/materials/:id', handlePatch);
