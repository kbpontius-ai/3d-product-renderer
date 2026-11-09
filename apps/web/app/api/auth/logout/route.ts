import { NextResponse } from 'next/server';
import { route } from '@/lib/server/observability';
import { assertSameOrigin, clearSessionCookie, getAuthService, readSessionToken } from '@/lib/server/auth';

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const token = await readSessionToken();
  if (token) await getAuthService().logout(token);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}

export const POST = route('auth/logout', handlePost);
