import { NextResponse } from 'next/server';
import { cancelJob, deleteJob, getJob } from '@pr/render-jobs';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { handleRouteError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { assetUrl } from '@/lib/server/storage';
import { withDownloadUrls } from '@/lib/server/renders-view';

type Params = { params: Promise<{ id: string }> };

async function handleGet(_request: Request, { params }: Params) {
  try {
    const ctx = await requireTenant();
    const viewer = ctx.userId ?? ctx.orgId;
    const { id } = await params;
    return NextResponse.json(withDownloadUrls(await getJob(getSql(), ctx, id), (key) => assetUrl(key, viewer)));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Cancelling is a DELETE of the work, not of the record: the job stays, marked cancelled. */
/**
 * Getting rid of a render.
 *
 * One verb, because that is how a person thinks about it: a render still going is cancelled, and a
 * finished one is removed from the gallery. Which of the two happened is in the response — a live
 * job comes back cancelled, a deleted one comes back as no content.
 */
async function handleDelete(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
    const ctx = await requireTenant();
    const viewer = ctx.userId ?? ctx.orgId;
    const { id } = await params;

    const job = await getJob(getSql(), ctx, id);
    if (job.status === 'queued' || job.status === 'running') {
      return NextResponse.json(withDownloadUrls(await cancelJob(getSql(), ctx, id), (key) => assetUrl(key, viewer)));
    }

    await deleteJob(getSql(), ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = route('renders/:id', handleGet);
export const DELETE = route('renders/:id', handleDelete);
