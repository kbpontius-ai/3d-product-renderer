import { NextResponse } from 'next/server';
import { listJobs } from '@pr/render-jobs';
import { requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { handleRouteError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { assetUrl } from '@/lib/server/storage';
import { withDownloadUrls } from '@/lib/server/renders-view';

/** The organisation's renders, newest first. Polled by the job tray while anything is in flight. */
async function handleGet() {
  try {
    const ctx = await requireTenant();
    const viewer = ctx.userId ?? ctx.orgId;
    const jobs = await listJobs(getSql(), ctx);
    return NextResponse.json({ jobs: jobs.map((job) => withDownloadUrls(job, (key) => assetUrl(key, viewer))) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = route('renders', handleGet);
