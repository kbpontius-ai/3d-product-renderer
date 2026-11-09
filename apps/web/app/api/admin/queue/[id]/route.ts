import { NextResponse } from 'next/server';
import { jobLog } from '@pr/admin/status';
import { cancelJobForStaff, getJobForStaff, retryJob } from '@pr/render-jobs';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** One job: look at it and its worker's log, put it back, or stop it. */
export const runtime = 'nodejs';

async function handleGet(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  const sql = getSql();
  const job = await getJobForStaff(sql, id);
  return NextResponse.json({ ...job, log: await jobLog(sql, 'render', id) });
}

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as { action?: string; reason?: string };
  const sql = getSql();

  if (body.action === 'retry') return NextResponse.json(await retryJob(sql, id, principal.userId));
  if (body.action === 'cancel') {
    return NextResponse.json(
      await cancelJobForStaff(sql, id, principal.userId, body.reason?.slice(0, 200) || undefined),
    );
  }

  throw new HttpError(422, 'invalid', 'action must be retry or cancel');
}

export const GET = route('admin/queue/:id', handleGet);
export const POST = route('admin/queue/:id', handlePost);
