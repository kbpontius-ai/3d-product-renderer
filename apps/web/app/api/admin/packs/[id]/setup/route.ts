import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PresentationOrientation } from '@pr/design-schema';
import { updateProductSetup, OrientationEditError } from '@pr/catalog';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

const Patch = z
  .object({
    productKey: z.string().min(1),
    variantKey: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    orientation: PresentationOrientation.optional(),
    materialDefaults: z.record(z.string(), z.string().min(1)).optional(),
  })
  .refine((v) => Boolean(v.orientation || v.materialDefaults), 'Nothing to save.');
async function patch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const parsed = Patch.safeParse(await request.json());
  if (!parsed.success)
    throw new HttpError(422, 'invalid', parsed.error.issues.map((i) => i.message).join('; '));
  const { id } = await params;
  try {
    return NextResponse.json(
      await updateProductSetup(getSql(), { packId: id, ...parsed.data }, principal.userId),
    );
  } catch (error) {
    if (error instanceof OrientationEditError)
      throw new HttpError(
        error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 422,
        error.code,
        error.message,
      );
    throw error;
  }
}
export const PATCH = route('admin/packs/:id/setup', patch);
