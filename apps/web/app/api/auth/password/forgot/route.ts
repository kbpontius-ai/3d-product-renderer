import { NextResponse } from 'next/server';
import { assertSameOrigin, getAuthService } from '@/lib/server/auth';
import { clientIp, handleAuthError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

async function handlePost(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json()) as { email?: string };
    if (body.email) {
      await getAuthService().requestPasswordReset(body.email, { ip: clientIp(request) });
    }
    // Always the same answer: whether the address exists is not ours to disclose.
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleAuthError(error);
  }
}

export const POST = route('auth/password/forgot', handlePost);
