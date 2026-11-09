import { NextResponse } from 'next/server';
import { assertSameOrigin, getAuthService, setSessionCookie } from '@/lib/server/auth';
import { clientIp, handleAuthError, problem } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

async function handlePost(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { token?: string; password?: string };
    if (!body.token || !body.password) return problem('invite_invalid', 400);

    const { token, principal } = await getAuthService().acceptInvitation(
      { token: body.token, password: body.password },
      { ip: clientIp(request) },
    );

    await setSessionCookie(token);
    return NextResponse.json({ email: principal.email, role: principal.role });
  } catch (error) {
    return handleAuthError(error);
  }
}

export const POST = route('auth/invite/accept', handlePost);
