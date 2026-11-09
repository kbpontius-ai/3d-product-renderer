import { NextResponse } from 'next/server';
import { authorize } from '@pr/auth';
import { assertSameOrigin, getAuthService } from '@/lib/server/auth';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { requireOwner } from '@/lib/server/org';
import { devToolingEnabled } from '@/lib/server/dev-only';
import { invitationResponse } from '@/lib/invitation-response';

/**
 * Inviting somebody into my own organisation, and taking it back (F-ORG-02, F-AUTH-01).
 *
 * The organisation is taken from the session and never from the request. `/api/admin/invitations`
 * accepts an `orgId` in the body because staff genuinely invite into organisations they are not in;
 * an owner inviting into somebody else's is the whole attack, so the parameter simply does not
 * exist here.
 *
 * Resending (`action: 'resend'`) invites the same address again with the role it was first given,
 * which revokes the previous link — one live invitation per address, always. The link is not
 * returned outside development, and the response says whether the email actually went.
 */
export const runtime = 'nodejs';

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const principal = await requireOwner();
  authorize(principal, 'invite.create', { orgId: principal.orgId });

  const body = (await request.json()) as { email?: string; role?: string; action?: string };
  if (!body.email) throw new HttpError(422, 'invalid', 'an email is needed');
  // `staff` is not on the menu, whatever arrives: it is not a role an organisation grants itself.
  if (body.role !== undefined && body.role !== 'owner' && body.role !== 'member') {
    throw new HttpError(422, 'invalid', 'role must be owner or member');
  }

  const auth = getAuthService();
  const result =
    body.action === 'resend'
      ? await auth.resendInvitation({ orgId: principal.orgId, email: body.email, invitedBy: principal.userId })
      : await auth.createInvitation({
          orgId: principal.orgId,
          email: body.email,
          role: body.role === 'owner' ? 'owner' : 'member',
          invitedBy: principal.userId,
        });
  if (!result) throw new HttpError(404, 'not_found', 'there is no invitation waiting for that address');

  const appUrl = process.env['APP_URL'] ?? 'http://localhost:3000';
  return NextResponse.json(
    invitationResponse({ email: body.email, ...result }, { appUrl, exposeLink: devToolingEnabled() }),
    { status: 201 },
  );
}

async function handleDelete(request: Request) {
  assertSameOrigin(request);
  const principal = await requireOwner();
  authorize(principal, 'invite.revoke', { orgId: principal.orgId });

  const email = new URL(request.url).searchParams.get('email');
  if (!email) throw new HttpError(422, 'invalid', 'an email is needed');

  await getAuthService().revokeInvitation(principal.orgId, email, principal.userId);
  return new NextResponse(null, { status: 204 });
}

export const POST = route('org/invitations', handlePost);
export const DELETE = route('org/invitations', handleDelete);
