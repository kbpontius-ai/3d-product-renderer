import { NextResponse } from 'next/server';
import { assertSameOrigin, getAuthService } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { devToolingEnabled } from '@/lib/server/dev-only';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { invitationResponse } from '@/lib/invitation-response';

/**
 * Inviting someone, as staff (F-AUTH-01): invite, resend, revoke.
 *
 * This is the real path that `/api/dev/invite` stood in for. Resending revokes the previous link, so
 * only one invitation is ever live. The link itself is not returned outside development, and the
 * response says whether the email actually went (`invitationResponse`).
 */
export const runtime = 'nodejs';

const appUrl = () => process.env['APP_URL'] ?? 'http://localhost:3000';

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const principal = await requireStaff();

  const body = (await request.json()) as { orgId?: string; email?: string; role?: string; action?: string };
  if (!body.orgId || !body.email) throw new HttpError(422, 'invalid', 'an organisation and an email are needed');

  const auth = getAuthService();
  const result =
    body.action === 'resend'
      ? await auth.resendInvitation({ orgId: body.orgId, email: body.email, invitedBy: principal.userId, isStaff: true })
      : await auth.createInvitation({
          orgId: body.orgId,
          email: body.email,
          role: body.role === 'owner' ? 'owner' : 'member',
          invitedBy: principal.userId,
          isStaff: true,
        });
  if (!result) throw new HttpError(404, 'not_found', 'there is no invitation waiting for that address');

  return NextResponse.json(
    invitationResponse({ email: body.email, ...result }, { appUrl: appUrl(), exposeLink: devToolingEnabled() }),
    { status: 201 },
  );
}

async function handleDelete(request: Request) {
  assertSameOrigin(request);
  const principal = await requireStaff();

  const query = new URL(request.url).searchParams;
  const orgId = query.get('orgId');
  const email = query.get('email');
  if (!orgId || !email) throw new HttpError(422, 'invalid', 'an organisation and an email are needed');

  await getAuthService().revokeInvitation(orgId, email, principal.userId, { isStaff: true });
  return new NextResponse(null, { status: 204 });
}

export const POST = route('admin/invitations', handlePost);
export const DELETE = route('admin/invitations', handleDelete);
