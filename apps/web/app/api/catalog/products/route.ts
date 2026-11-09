import { NextResponse } from 'next/server';
import { route } from '@/lib/server/observability';
import { listProducts } from '@pr/catalog';
import { getPrincipal } from '@/lib/server/auth';
import { getSql, databaseConfigured } from '@/lib/server/db';

/** Catalog listing, scoped to the caller's organisation by the same policies that guard designs. */
async function handleGet(request: Request) {
  if (!databaseConfigured()) {
    return NextResponse.json({ error: { code: 'not_configured' } }, { status: 503 });
  }

  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: { code: 'unauthenticated' } }, { status: 401 });

  const url = new URL(request.url);
  const products = await listProducts(
    getSql(),
    { orgId: principal.orgId, userId: principal.userId },
    {
      ...(url.searchParams.get('category') ? { category: url.searchParams.get('category')! } : {}),
      ...(url.searchParams.get('q') ? { search: url.searchParams.get('q')! } : {}),
    },
  );

  return NextResponse.json({ products });
}

export const GET = route('catalog/products', handleGet);
