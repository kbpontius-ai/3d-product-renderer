import { setQuotas, type Quotas } from '@pr/admin';
import { NextResponse } from 'next/server';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/**
 * The limits, on their own path.
 *
 * Separate from the organisation itself because changing what a customer may spend is the one
 * administrative action with a direct bill attached, and it reads better in an audit log as its
 * own route than as a field on a general update.
 */
export const runtime = 'nodejs';

const KEYS: (keyof Quotas)[] = [
  'rendersPerDay',
  'gpuSecondsPerMonth',
  'storageBytes',
  'maxConcurrentJobs',
  'maxResolutionPx',
];

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as Record<string, unknown>;
  const quotas: Partial<Quotas> = {};
  for (const key of KEYS) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value)) throw new HttpError(422, 'invalid', `${key} must be a number`);
    quotas[key] = Math.round(value);
  }
  if (Object.keys(quotas).length === 0) throw new HttpError(422, 'invalid', 'nothing to change');

  return NextResponse.json(await setQuotas(getSql(), id, quotas, principal.userId));
}

export const PATCH = route('admin/orgs/:id/quotas', handlePatch);
