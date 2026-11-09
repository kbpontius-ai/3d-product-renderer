import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/server/admin';
import { route } from '@/lib/server/observability';
import { loadStatus } from '@/lib/server/system-status';

/** The System Status page's refresh (F-ADM-15). Staff only. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGet(request: Request) {
  await requireStaff();
  const params = new URL(request.url).searchParams;
  const level = params.get('level');
  const service = params.get('service');

  const payload = await loadStatus({
    events: {
      ...(level === 'warn' || level === 'error' ? { level } : {}),
      ...(service ? { service: service.slice(0, 64) } : {}),
    },
  });
  return NextResponse.json(payload, { headers: { 'cache-control': 'no-store' } });
}

export const GET = route('admin/status', handleGet);
