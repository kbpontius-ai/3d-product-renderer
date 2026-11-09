/**
 * Creates a development organisation and prints an invitation link.
 *
 *   export DATABASE_URL=$(./scripts/dev-db.sh url)
 *   pnpm db:migrate && pnpm seed:dev you@example.com
 *
 * There is no other way to create an account: the platform is invite-only by construction, and
 * that includes the first one.
 */
import { connect, uuidv7, withStaff } from '@pr/db';
import { AuthService } from '@pr/auth';
import { setStaff } from '@pr/admin';

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const email = process.argv[2] ?? 'owner@example.com';
  const appUrl = process.env['APP_URL'] ?? 'http://localhost:3000';
  const sql = connect({ url });

  try {
    const orgId = await withStaff(sql, async (tx) => {
      const [existing] = await tx`select id from organizations where slug = 'demo'`;
      if (existing) return existing['id'] as string;

      const id = uuidv7();
      await tx`insert into organizations (id, name, slug) values (${id}, 'Demo Organisation', 'demo')`;
      await tx`insert into org_quotas (org_id) values (${id})`;
      return id;
    });

    const auth = new AuthService({
      sql,
      appUrl,
      mailer: { async send() {} }, // the link is printed below instead
    });

    const { token } = await auth.createInvitation({
      orgId,
      email,
      role: 'owner',
      invitedBy: null,
      isStaff: true,
    });

    // The first account on a deployment is its administrator: without staff there is nobody who can
    // import a pack, invite anyone else, or look at the queue. Pass --member for an ordinary one.
    const staff = !process.argv.includes('--member');
    if (staff) await setStaff(sql, email, true);

    console.log(`organisation: ${orgId}`);
    console.log(`role: ${staff ? 'staff (admin console at /admin)' : 'owner'}`);
    console.log(`invitation for ${email}:`);
    console.log(`  ${appUrl}/invite/accept?token=${token}`);
  } finally {
    await sql.end();
  }
}

void main();
