import { NextResponse } from 'next/server';
import { deleteDesign, loadDesign, renameDesign, saveDesign } from '@pr/designs';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { handleRouteError, HttpError } from '@/lib/server/http';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';

/**
 * One design (build order G2).
 *
 * PATCH carries `expectedVersion` — the optimistic lock. Two tabs on the same design cannot
 * overwrite each other silently: the loser gets a 409 naming the version it must rebase onto.
 */

type Params = { params: Promise<{ id: string }> };

async function handleGet(_request: Request, { params }: Params) {
  try {
    const ctx = await requireTenant();
    const { id } = await params;
    return NextResponse.json(await loadDesign(getSql(), ctx, id));
  } catch (error) {
    return handleRouteError(error);
  }
}

async function handlePatch(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
    const ctx = await requireTenant();
    await enforceLimit('designWrite', ctx.userId ?? ctx.orgId);
    const { id } = await params;

    const body = (await request.json()) as {
      document?: unknown;
      expectedVersion?: number;
      name?: string;
    };

    // A rename on its own does not touch the document, so it does not need the lock either.
    if (body.document === undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new HttpError(400, 'nothing_to_update');
      }
      await renameDesign(getSql(), ctx, id, body.name.trim().slice(0, 200));
      return NextResponse.json({ name: body.name.trim().slice(0, 200) });
    }

    if (!Number.isInteger(body.expectedVersion)) throw new HttpError(428, 'expected_version_required');

    const result = await saveDesign(getSql(), ctx, {
      designId: id,
      document: body.document,
      expectedVersion: body.expectedVersion!,
      ...(body.name ? { name: body.name } : {}),
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

async function handleDelete(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
    const ctx = await requireTenant();
    const { id } = await params;
    await deleteDesign(getSql(), ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = route('designs/:id', handleGet);
export const PATCH = route('designs/:id', handlePatch);
export const DELETE = route('designs/:id', handleDelete);
