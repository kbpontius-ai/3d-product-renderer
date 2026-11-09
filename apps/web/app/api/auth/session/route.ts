import { NextResponse } from 'next/server';
import { route } from '@/lib/server/observability';
import { getPrincipal } from '@/lib/server/auth';

async function handleGet() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({
    authenticated: true,
    email: principal.email,
    role: principal.role,
    orgId: principal.orgId,
  });
}

export const GET = route('auth/session', handleGet);
