import { NextResponse } from 'next/server';
import { listAllJobs, queueSnapshot, retryFailed, type JobStatus } from '@pr/render-jobs';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** The queue, across every organisation (F-ADM-07). */
export const runtime = 'nodejs';

const STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'canceled'];

async function handleGet(request: Request) {
  await requireStaff();
  const params = new URL(request.url).searchParams;
  const status = params.get('status');
  const sql = getSql();

  const [snapshot, jobs] = await Promise.all([
    queueSnapshot(sql),
    listAllJobs(sql, { ...(STATUSES.includes(status as JobStatus) ? { status: status as JobStatus } : {}) }),
  ]);

  return NextResponse.json({ snapshot, jobs });
}

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const principal = await requireStaff();

  const body = (await request.json()) as { action?: string; code?: string; limit?: number };
  if (body.action !== 'retry-failed') throw new HttpError(422, 'invalid', 'unknown action');

  const requeued = await retryFailed(
    getSql(),
    { limit: Math.min(Math.max(Number(body.limit ?? 50), 1), 200) },
    principal.userId,
  );
  return NextResponse.json({ requeued });
}

export const GET = route('admin/queue', handleGet);
export const POST = route('admin/queue', handlePost);
