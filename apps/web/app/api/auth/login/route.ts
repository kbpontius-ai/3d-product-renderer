import { NextResponse } from 'next/server';
import { assertSameOrigin, getAuthService, setSessionCookie } from '@/lib/server/auth';
import { clientIp, handleAuthError, problem } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

async function handlePost(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) return problem('invalid_credentials', 400);

    const { token, principal } = await getAuthService().login(
      { email: body.email, password: body.password },
      { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined },
    );

    await setSessionCookie(token);
    return NextResponse.json({ email: principal.email, role: principal.role });
  } catch (error) {
    return handleAuthError(error);
  }
}

export const POST = route('auth/login', handlePost);
