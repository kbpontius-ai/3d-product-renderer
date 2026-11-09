import { randomBytes } from 'node:crypto';
import { connect, migrate, withStaff, type Sql } from './client.js';

/**
 * Integration-test support: a private database per test file.
 *
 * Tests that exercise row-level security must run against a real PostgreSQL — the policies are the
 * thing being tested, and no fake reproduces them. Each file gets its own database so the suite can
 * still run in parallel, and drops it afterwards.
 */

export interface TestDatabase {
  url: string;
  sql: Sql;
  name: string;
  drop(): Promise<void>;
}

export const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
export const hasDatabase = DATABASE_URL.length > 0;
if (process.env['CI'] && !hasDatabase) {
  throw new Error('CI integration tests require DATABASE_URL');
}

export async function createTestDatabase(
  prefix = 'pr_test',
  migrationDir?: string,
): Promise<TestDatabase> {
  if (!hasDatabase) throw new Error('DATABASE_URL is not set');

  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = connect({ url: DATABASE_URL, max: 1 });
  try {
    await refuseSuperuser(admin);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const url = replaceDatabase(DATABASE_URL, name);
  const sql = connect({ url, max: 4 });
  await migrate(sql, migrationDir);

  return {
    url,
    sql,
    name,
    async drop() {
      await sql.end();
      const cleanup = connect({ url: DATABASE_URL, max: 1 });
      // Terminate stragglers first: a leaked connection would otherwise block the drop.
      await cleanup.unsafe(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and usename = current_user and backend_type = 'client backend'`,
      );
      await cleanup.unsafe(`drop database if exists ${name}`);
      await cleanup.end();
    },
  };
}

/**
 * Refuses to run the suite as a superuser.
 *
 * `force row level security` forces policies on the table *owner*. It does not touch a superuser,
 * who bypasses every policy — silently, with no error and no warning. So a suite pointed at a
 * superuser is not testing tenancy at all; it is watching a database hand back every row it has and
 * calling the ones it recognises a pass.
 *
 * CI spent its whole life in that state. The postgres image's `POSTGRES_USER` names the *bootstrap
 * superuser*, and the workflow set it to `product_renderer` — the application role — so every run of the
 * RLS tests since they were written proved nothing about RLS. It did fail, on the handful of tests
 * that expect a rejection, with `promise resolved "undefined" instead of rejecting`; nothing in
 * that says which of a hundred things is wrong.
 *
 * A precondition rather than a test of its own, because it has to hold for every file that touches
 * the database, and this function is what every one of them goes through.
 */
async function refuseSuperuser(sql: Sql): Promise<void> {
  const rows = await sql`
    select current_user as who, current_setting('is_superuser') = 'on' as superuser
  `;
  const row = rows[0];
  if (!row?.['superuser']) return;

  throw new Error(
    `the integration suite is connected as "${row['who']}", which is a superuser. Row-level ` +
      'security does not apply to superusers — not even under FORCE ROW LEVEL SECURITY — so every ' +
      'tenancy assertion in this suite would be meaningless. Point DATABASE_URL at an ordinary ' +
      'role that has CREATEDB.',
  );
}

function replaceDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/** Minimal fixtures: two organisations, so cross-tenant tests always have somewhere to leak to. */
export async function seedOrganizations(sql: Sql): Promise<{ alpha: string; beta: string }> {
  const alpha = '00000000-0000-7000-8000-00000000a1fa';
  const beta = '00000000-0000-7000-8000-00000000be7a';

  // Creating organisations is a staff action: the policies refuse it from an ordinary session.
  await withStaff(sql, async (tx) => {
    await tx`
      insert into organizations (id, name, slug) values
        (${alpha}, 'Alpha Organisation', 'alpha'),
        (${beta}, 'Beta Brands', 'beta')
      on conflict do nothing`;
    // Quotas come with an organisation in production, so they come with one here too.
    await tx`
      insert into org_quotas (org_id) values (${alpha}), (${beta}) on conflict do nothing`;
  });

  return { alpha, beta };
}
