import { NextResponse } from 'next/server';
import { jobLog } from '@pr/admin/status';
import { cancelIngestion, getIngestion } from '@pr/cad-jobs';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** One ingestion: look at what it produced, or stop it. */
export const runtime = 'nodejs';

async function handleGet(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const principal = await requireStaff();
  const { id } = await params;
  const sql = getSql();
  const job = await getIngestion(sql, { orgId: principal.orgId, userId: principal.userId }, id);
  return NextResponse.json({ job, log: await jobLog(sql, 'cad', id) });
}

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as { action?: string };
  if (body.action !== 'cancel') throw new HttpError(422, 'invalid', 'action must be cancel');

  // A running import finds out at its next heartbeat, which matters here: a heavy assembly holds a
  // container for an hour, and that is an hour of a machine nobody is waiting on.
  const job = await cancelIngestion(getSql(), { orgId: principal.orgId, userId: principal.userId }, id);
  return NextResponse.json({ job });
}

export const GET = route('admin/cad/:id', handleGet);
export const POST = route('admin/cad/:id', handlePost);
