import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { request, type FullConfig } from '@playwright/test';

/**
 * Provisions the one account the suite signs in as.
 *
 * Accepting an invitation is rate limited per address *and* per IP — correctly, since that is the
 * only door into the product. A suite that made an account per spec file would spend that budget on
 * itself and then fail somewhere unrelated, so the specs that merely need "a signed-in user" share
 * this one. The tests that are *about* the account lifecycle still make their own.
 */

export const STORAGE_STATE = '.tmp/e2e-user.json';
export const STAFF_STORAGE_STATE = '.tmp/e2e-staff.json';
export const ORIENTATION_STAFF_STORAGE_STATE = '.tmp/e2e-orientation-staff.json';
/**
 * A plain member of the same organisation as the shared user, and the file naming them.
 *
 * Provisioned here rather than inside `org.spec.ts` for the reason the note above gives: accepting
 * an invitation is capped at ten per ten minutes per IP, and a spec that mints its own account
 * spends that budget every run — which is how an earlier draft of the organisation spec broke
 * `designs.spec.ts` instead of itself.
 */
export const MEMBER_STORAGE_STATE = '.tmp/e2e-member.json';
export const MEMBER_EMAIL_FILE = '.tmp/e2e-member-email.txt';
export const PASSWORD = 'Chamfer-Ink-Ridge-8821';

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (process.env['CI'] &&
      (process.env['DEV_TOOLING'] !== 'true' || !process.env['DATABASE_URL'])) {
    throw new Error('CI E2E requires DEV_TOOLING=true and an isolated DATABASE_URL');
  }
  if (process.env['DEV_TOOLING'] !== 'true') return;

  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:3100';
  await mkdir(dirname(STORAGE_STATE), { recursive: true });

  await provision(baseURL, STORAGE_STATE);

  // A second account for the admin console. Staff is a role nothing in the product can grant
  // itself — the first one always comes from whoever holds the database — so the suite grants it
  // the same way an operator would, rather than through a door the app would have to leave open.
  const staffEmail = await provision(baseURL, STAFF_STORAGE_STATE);
  await grantStaff(staffEmail);

  // Pack archive inspection/import spends the production per-account upload budget.
  // Orientation uses its own staff session so it cannot starve the existing pack regression suite.
  const orientationStaffEmail = await provision(baseURL, ORIENTATION_STAFF_STORAGE_STATE);
  await grantStaff(orientationStaffEmail);

  const memberEmail = await provision(baseURL, MEMBER_STORAGE_STATE, 'member');
  await writeFile(MEMBER_EMAIL_FILE, memberEmail, 'utf8');
}

/** Invites an account, accepts it, and saves its cookies. Returns the address. */
async function provision(
  baseURL: string,
  storageState: string,
  role: 'owner' | 'member' = 'owner',
): Promise<string> {
  const api = await request.newContext({ baseURL });
  try {
    const email = `suite-${randomBytes(6).toString('hex')}@example.com`;
    const invited = await api.post('/api/dev/invite', { data: { email, orgSlug: 'e2e', role } });
    if (!invited.ok()) throw new Error(`could not invite the suite user: ${invited.status()}`);
    const { token } = (await invited.json()) as { token: string };

    const accepted = await api.post('/api/auth/invite/accept', {
      data: { token, password: PASSWORD },
    });
    if (!accepted.ok()) throw new Error(`could not accept the invitation: ${accepted.status()}`);

    await writeFile(storageState, JSON.stringify(await api.storageState()), 'utf8');
    return email;
  } finally {
    await api.dispose();
  }
}

async function grantStaff(email: string): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) return;

  const { connect } = await import('@pr/db');
  const { setStaff } = await import('@pr/admin');
  const sql = connect({ url });
  try {
    await setStaff(sql, email, true);
    await roomToWork(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Room for the suite to work in.
 *
 * The default quotas are a production judgement — fifty renders a day, three at once — and the
 * suite submits more than that in an afternoon of runs, on one organisation, with a worker slowly
 * finishing them. Tests then fail on 429s that say nothing about the code. The quota logic itself
 * is covered where it belongs, in the queue's own tests. Repeated CAD runs likewise exhaust the
 * twenty-ingest daily budget on this shared test organisation.
 */
async function roomToWork(
  sql: Awaited<ReturnType<typeof import('@pr/db').connect>>,
): Promise<void> {
  const { withStaff } = await import('@pr/db');
  await withStaff(sql, async (tx) => {
    const [org] = await tx`select id from organizations where slug = 'e2e'`;
    if (!org) return;
    await tx`
      insert into org_quotas (org_id, renders_per_day, max_concurrent_jobs, cad_ingests_per_day)
      values (${org['id']}, 5000, 20, 5000)
      on conflict (org_id) do update set renders_per_day = 5000, max_concurrent_jobs = 20,
        cad_ingests_per_day = 5000`;
  });
}
