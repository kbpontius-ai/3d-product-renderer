import { NextResponse } from 'next/server';
import { assertSameOrigin, getAuthService } from '@/lib/server/auth';
import { handleAuthError, problem } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

async function handlePost(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { token?: string; password?: string };
    if (!body.token || !body.password) return problem('reset_invalid', 400);

    await getAuthService().completePasswordReset({ token: body.token, password: body.password });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleAuthError(error);
  }
}

export const POST = route('auth/password/reset', handlePost);
