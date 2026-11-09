import { NextResponse } from 'next/server';
import { listUsers } from '@pr/admin';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { route } from '@/lib/server/observability';

/** Accounts across every organisation, searchable by address. */
export const runtime = 'nodejs';

async function handleGet(request: Request) {
  await requireStaff();
  const query = new URL(request.url).searchParams.get('q');
  return NextResponse.json({ users: await listUsers(getSql(), { ...(query ? { query } : {}) }) });
}

export const GET = route('admin/users', handleGet);
