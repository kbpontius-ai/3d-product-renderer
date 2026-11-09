import { NextResponse } from 'next/server';
import { route } from '@/lib/server/observability';
import { uuidv7, withStaff } from '@pr/db';
import { getAuthService } from '@/lib/server/auth';
import { getSql } from '@/lib/server/db';
import { devToolingEnabled } from '@/lib/server/dev-only';

/**
 * Issues an invitation without an admin console. Stands in for `POST /api/admin/invites`
 * (docs/13-api.md) until that exists.
 */
async function handlePost(request: Request) {
  if (!devToolingEnabled()) return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    orgSlug?: string;
    role?: string;
  };
  if (!body.email) return NextResponse.json({ error: { code: 'email_required' } }, { status: 400 });

  const slug = body.orgSlug ?? 'dev';
  const sql = getSql();

  const orgId = await withStaff(sql, async (tx) => {
    const [existing] = await tx`select id from organizations where slug = ${slug}`;
    if (existing) return existing['id'] as string;

    const id = uuidv7();
    await tx`insert into organizations (id, name, slug) values (${id}, ${`Dev ${slug}`}, ${slug})`;
    await tx`insert into org_quotas (org_id) values (${id})`;
    return id;
  });

  // Owner by default, because that is what every existing caller wants. `member` exists so the
  // suite can provision the one account it needs to prove that a member is refused — and `staff` is
  // not on offer here any more than it is anywhere else.
  const role = body.role === 'member' ? 'member' : 'owner';

  const { token } = await getAuthService().createInvitation({
    orgId,
    email: body.email,
    role,
    invitedBy: null,
    isStaff: true,
  });

  return NextResponse.json({ orgId, email: body.email, token, url: `/invite/accept?token=${token}` });
}

export const POST = route('dev/invite', handlePost);
