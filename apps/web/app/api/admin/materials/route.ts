import { NextResponse } from 'next/server';
import { createMaterial, listMaterialsForStaff, MaterialError } from '@pr/catalog';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** The material library (F-ADM-04). */
export const runtime = 'nodejs';

const FAMILIES = ['plastic', 'metal', 'paperboard', 'glass', 'ink', 'foil', 'coating'] as const;

async function handleGet() {
  await requireStaff();
  return NextResponse.json({ materials: await listMaterialsForStaff(getSql()) });
}

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const principal = await requireStaff();

  const body = (await request.json()) as {
    key?: string;
    name?: string;
    family?: string;
    definition?: unknown;
  };
  if (!body.key || !body.name) throw new HttpError(422, 'invalid', 'a key and a name are needed');
  if (!FAMILIES.includes(body.family as (typeof FAMILIES)[number])) {
    throw new HttpError(422, 'invalid', 'unknown material family');
  }

  try {
    const material = await createMaterial(
      getSql(),
      {
        key: body.key,
        name: body.name,
        family: body.family as (typeof FAMILIES)[number],
        definition: body.definition ?? {},
      },
      principal.userId,
    );
    return NextResponse.json(material, { status: 201 });
  } catch (error) {
    if (error instanceof MaterialError) {
      throw new HttpError(error.code === 'conflict' ? 409 : 422, error.code, error.message);
    }
    throw error;
  }
}

export const GET = route('admin/materials', handleGet);
export const POST = route('admin/materials', handlePost);
