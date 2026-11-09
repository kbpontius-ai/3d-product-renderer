import { NextResponse } from 'next/server';
import { listNotifications, markRead, unreadCount } from '@pr/notifications';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { route } from '@/lib/server/observability';

/**
 * The bell (F-REND-08).
 *
 * Polled rather than pushed: the thing being waited for takes minutes, a poll every half minute is
 * cheaper than holding a connection open for each idle tab, and it keeps working through the sleep
 * a laptop takes between the render starting and finishing.
 */
export const runtime = 'nodejs';

async function handleGet(request: Request) {
  const ctx = await requireTenant();
  const unreadOnly = new URL(request.url).searchParams.get('unread') === 'true';
  const sql = getSql();

  const [notifications, unread] = await Promise.all([
    listNotifications(sql, ctx, { unreadOnly, limit: 20 }),
    unreadCount(sql, ctx),
  ]);

  const response = NextResponse.json({ notifications, unread });
  // Per-account content behind a shared path: without this a proxy or the browser cache could hand
  // one person another's bell.
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Vary', 'Cookie');
  return response;
}

async function handlePatch(request: Request) {
  assertSameOrigin(request);
  const ctx = await requireTenant();

  const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : undefined;

  const marked = await markRead(getSql(), ctx, ids);
  return NextResponse.json({ marked });
}

export const GET = route('notifications', handleGet);
export const PATCH = route('notifications', handlePatch);
