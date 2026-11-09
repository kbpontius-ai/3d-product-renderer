/**
 * Grants (or revokes) staff on an account.
 *
 *   pnpm grant:staff you@example.com
 *   pnpm grant:staff you@example.com --revoke
 *
 * Staff are the only people who can create staff, so the first one has to come from outside the
 * application: whoever holds the database credentials. Every later promotion happens in the admin
 * console, where it is attributed.
 */
import { connect } from '@pr/db';
import { setStaff } from '@pr/admin';

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const email = process.argv[2];
  if (!email) throw new Error('usage: pnpm grant:staff <email> [--revoke]');
  const revoke = process.argv.includes('--revoke');

  const sql = connect({ url });
  try {
    const user = await setStaff(sql, email, !revoke);
    console.log(`${user.email} is now ${user.role} in ${user.orgName}`);
  } finally {
    await sql.end();
  }
}

void main();
