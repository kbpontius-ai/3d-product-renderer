import { ArtworkError } from '@pr/artworks';
import { NextResponse } from 'next/server';
import { loadDesign } from '@pr/designs';
import { RenderLighting } from '@pr/design-schema';
import { ENVIRONMENTS } from '@pr/scene';
import { submitRender } from '@pr/render-jobs';
import { withTenant } from '@pr/db';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { handleRouteError, HttpError } from '@/lib/server/http';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';
import { currentLog, currentRequestId } from '@pr/observability';
import {
  buildSpecForDesign,
  RENDER_FORMATS,
  RENDER_SIZES,
  type RenderFormatKey,
  type RenderPreset,
  type RenderSizeKey,
} from '@/lib/server/render-spec';
import { orgQuotas } from '@/lib/server/quotas';
import { rendererVersion } from '@/lib/server/renderer';

/**
 * Submitting a render (W-08, F-REND-01).
 *
 * The spec is built from the design as it is stored, not from anything the browser sends — a client
 * cannot ask for a render of a design it did not save, or of settings the editor would have
 * refused. Viewer lighting is a separately validated job snapshot.
 */

export const runtime = 'nodejs';

const PRESETS: RenderPreset[] = ['draft', 'standard', 'final'];

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const ctx = await requireTenant();
    await enforceLimit('renderSubmit', ctx.userId ?? ctx.orgId);
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as {
      preset?: string;
      size?: string;
      widthPx?: number;
      heightPx?: number;
      format?: string;
      lighting?: unknown;
    };
    const parsedLighting = body.lighting === undefined ? undefined : RenderLighting.safeParse(body.lighting);
    if (parsedLighting && (!parsedLighting.success ||
      !ENVIRONMENTS.some((environment) => environment.key === parsedLighting.data.environmentKey))) {
      throw new HttpError(422, 'invalid_lighting', 'Choose a supported lighting preset with a valid rotation and orientation.');
    }
    const lighting = parsedLighting?.success ? parsedLighting.data : undefined;
    const preset = (
      PRESETS.includes(body.preset as RenderPreset) ? body.preset : 'standard'
    ) as RenderPreset;
    const format = (
      body.format && body.format in RENDER_FORMATS ? body.format : 'png16'
    ) as RenderFormatKey;
    const size = await resolveSize(ctx, body);

    const design = await loadDesign(getSql(), ctx, id);
    if (design.archivedArtworks?.length)
      throw new ArtworkError(
        'archived_artwork',
        'Restore archived artwork before rendering this design.',
        design.archivedArtworks,
      );
    if (design.document.placements.length === 0) {
      throw new HttpError(422, 'nothing_to_render', 'this design has no artwork placed on it');
    }

    const spec = await buildSpecForDesign(ctx, {
      document: design.document,
      designVersionId: await currentVersionId(ctx, id),
      preset,
      size,
      format,
      rendererVersion: await rendererVersion(),
      ...(lighting ? { lighting } : {}),
    });

    const traceId = currentRequestId();
    const result = await submitRender(getSql(), ctx, {
      designVersionId: await currentVersionId(ctx, id),
      spec,
      ...(traceId ? { traceId } : {}),
    });

    currentLog().info(result.deduped ? 'render deduped' : 'render queued', {
      jobId: result.job.id,
      preset,
      size,
      format,
    });

    return NextResponse.json(
      { ...result.job, deduped: result.deduped },
      { status: result.deduped ? 200 : 202 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/** The version a render is pinned to: the one the design currently points at. */
async function currentVersionId(
  ctx: { orgId: string; userId: string | null },
  designId: string,
): Promise<string> {
  const [row] = await withTenant(
    getSql(),
    ctx,
    (tx) =>
      tx`select current_version_id from designs where id = ${designId} and deleted_at is null`,
  );
  if (!row?.['current_version_id']) throw new HttpError(404, 'not_found');
  return row['current_version_id'] as string;
}

export const POST = route('designs/:id/renders', handlePost);

/**
 * The size to render at: a named preset, or an exact one within the organisation's ceiling.
 *
 * The ceiling is a quota rather than a constant because resolution is the one setting that costs
 * quadratically — a 8K render is sixteen times the 2K one, on someone else's bill.
 */
async function resolveSize(
  ctx: { orgId: string; userId: string | null },
  body: { size?: string; widthPx?: number; heightPx?: number },
): Promise<RenderSizeKey | { widthPx: number; heightPx: number }> {
  if (body.size !== 'custom') {
    return (body.size && body.size in RENDER_SIZES ? body.size : '2k') as RenderSizeKey;
  }

  const widthPx = Math.round(Number(body.widthPx));
  const heightPx = Math.round(Number(body.heightPx));
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx < 64 || heightPx < 64) {
    throw new HttpError(
      422,
      'invalid_size',
      'a custom size needs a width and a height of at least 64 px',
    );
  }

  const { maxResolutionPx } = await orgQuotas(ctx.orgId);
  if (widthPx > maxResolutionPx || heightPx > maxResolutionPx) {
    throw new HttpError(
      422,
      'size_over_quota',
      `this organisation may render up to ${maxResolutionPx} px on a side`,
    );
  }

  return { widthPx, heightPx };
}
