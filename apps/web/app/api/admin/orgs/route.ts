import { NextResponse } from 'next/server';
import { createOrganization, listOrganizations } from '@pr/admin';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { route } from '@/lib/server/observability';

/** Organisations, for staff (F-ADM-06). */
export const runtime = 'nodejs';

async function handleGet() {
  await requireStaff();
  return NextResponse.json({ organizations: await listOrganizations(getSql()) });
}

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const principal = await requireStaff();

  const body = (await request.json()) as { name?: string; slug?: string };
  const org = await createOrganization(getSql(), {
    name: String(body.name ?? ''),
    slug: String(body.slug ?? body.name ?? ''),
    actorId: principal.userId,
  });

  return NextResponse.json(org, { status: 201 });
}

export const GET = route('admin/orgs', handleGet);
export const POST = route('admin/orgs', handlePost);
