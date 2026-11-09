import { expect, request, test } from '@playwright/test';
import { PASSWORD, STAFF_STORAGE_STATE, STORAGE_STATE } from './global-setup';

/**
 * The admin console (W-11..W-13).
 *
 * Two things worth proving in a browser: that staff can actually run the platform from it, and that
 * everyone else cannot see that it exists.
 */

test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');

test.describe('as staff', () => {
  test.use({ storageState: STAFF_STORAGE_STATE });

  test('organizations are listed with their limits', async ({ page }) => {
    await page.goto('/admin');

    await expect(page.getByTestId('admin')).toBeVisible();
    await expect(page.getByTestId('org-table')).toBeVisible();
    // The suite's own organisation, created by the first invitation.
    await expect(page.getByTestId('org-e2e')).toBeVisible();
  });

  test('header sections keep organization context on every page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByTestId('org-e2e').locator('a').first().click();
    const name = await page.locator('.org-header h1').textContent();
    await expect(page.getByTestId('admin-nav-people')).toHaveCount(0);
    for (const section of ['people', 'products', 'limits', 'activity', 'overview']) {
      await page.getByTestId(`org-section-${section}`).click();
      await expect(page.getByTestId(`org-section-${section}`)).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByTestId('admin-nav-organizations')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.locator('.org-header h1')).toHaveText(name!);
      await expect(page.getByTestId(`org-${section}`)).toBeVisible();
    }
    await page.getByTestId('org-section-people').click();
    await expect(page.getByTestId('org-people')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.screenshot({ path: '.tmp/org-header-people-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: '.tmp/org-header-people-mobile.png', fullPage: true });
    await page.getByTestId('org-section-limits').click();
    await expect(page.getByTestId('quota-save')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.getByTestId('org-section-people').click();
    await page
      .getByTestId('org-users')
      .locator('tr', { has: page.locator('.chip') })
      .getByRole('link', { name: 'Manage →' })
      .click();
    await expect(page.getByTestId('org-person')).toBeVisible();
    await page.screenshot({ path: '.tmp/org-header-person.png', fullPage: true });
  });

  test('people filters stay scoped and mismatched person routes and mutations are refused', async ({
    page,
  }) => {
    await page.goto('/admin');
    await page.getByTestId('org-e2e').locator('a').first().click();
    await page.getByTestId('org-section-people').click();
    const peopleURL = page.url();
    const self = page.getByTestId('org-users').locator('tr', { has: page.locator('.chip') });
    const personPath = await self.getByRole('link', { name: 'Manage →' }).getAttribute('href');
    const email = await self.locator('strong').textContent();
    await page.getByTestId('people-search').fill(email!);
    await page.getByTestId('people-role').selectOption('staff');
    await page.getByTestId('people-status').selectOption('active');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByTestId('org-users').locator('tbody tr')).toHaveCount(1);
    await expect(page.getByTestId('org-users')).toContainText(email!);
    await page.getByTestId('people-status').selectOption('invited');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByTestId('org-users').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByText('No people match these filters.')).toBeVisible();
    await page.goto('/admin');
    const slug = `scope-${Date.now().toString(36)}`;
    await page.getByTestId('new-org-name').fill(slug);
    await page.getByTestId('new-org-submit').click();
    await page.getByTestId(`org-${slug}`).locator('a').first().click();
    const otherOrg = new URL(page.url()).pathname.split('/').at(-1)!;
    await page.getByTestId('org-section-people').click();
    await expect(page.getByTestId('org-users').locator('tbody tr')).toHaveCount(0);
    await page.locator('[data-testid=invite-person][data-hydrated]').click();
    await expect(page.getByTestId('invite-role')).toHaveValue('owner');
    await expect(page.getByTestId('invite-person-dialog')).toContainText(slug);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const userId = personPath!.split('/').at(-1)!;
    const response = await page.goto(`/admin/orgs/${otherOrg}/people/${userId}`);
    expect(response?.status()).toBe(404);
    const status = await page.evaluate(
      async ({ userId, otherOrg }) => {
        const response = await fetch(`/api/admin/users/${userId}?orgId=${otherOrg}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'member' }),
        });
        return response.status;
      },
      { userId, otherOrg },
    );
    expect(status).toBe(404);
    await page.goto(peopleURL);
    await expect(page.getByTestId('admin-nav-organizations')).toBeVisible();
    const invalid = await page.goto('/admin/orgs/not-an-id');
    expect(invalid?.status()).toBe(404);
  });

  test('pagination reaches accounts beyond the old 200-person cap and keeps filters', async ({
    page,
  }) => {
    test.skip(!process.env['DATABASE_URL'], 'needs a disposable test database');
    const { connect, withStaff } = await import('@pr/db');
    const sql = connect({ url: process.env['DATABASE_URL']! });
    const orgId = crypto.randomUUID();
    const slug = `pagination-${Date.now().toString(36)}`;
    try {
      await withStaff(sql, async (tx) => {
        await tx`insert into organizations (id, name, slug) values (${orgId}, 'Pagination Review', ${slug})`;
        await tx`insert into org_quotas (org_id) values (${orgId})`;
        await tx`
          insert into users (id, org_id, email, role, status)
          select gen_random_uuid(), ${orgId}, ${slug} || '-' || n || '@example.com', 'member', 'invited'
          from generate_series(1, 205) n`;
      });
      await page.goto(`/admin/orgs/${orgId}/people?q=${slug}&status=invited&role=member`);
      await expect(page.getByTestId('org-users').locator('tbody tr')).toHaveCount(50);
      await expect(page.getByTestId('list-pagination')).toContainText('1–50 of 205');
      for (let pageNumber = 2; pageNumber <= 5; pageNumber++) {
        await page.getByRole('link', { name: 'Next', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`page=${pageNumber}`));
        await expect(page.getByTestId('people-status')).toHaveValue('invited');
        await expect(page.getByTestId('people-role')).toHaveValue('member');
      }
      await expect(page.getByTestId('org-users').locator('tbody tr')).toHaveCount(5);
      await expect(page.getByTestId('list-pagination')).toContainText('201–205 of 205');
      await page.getByRole('link', { name: 'Previous', exact: true }).click();
      await expect(page.getByTestId('org-users').locator('tbody tr')).toHaveCount(50);
    } finally {
      await withStaff(sql, (tx) => tx`delete from organizations where id = ${orgId}`);
      await sql.end();
    }
  });

  test('accepted account controls suspend, restore and delete from person detail', async ({
    page,
  }) => {
    await page.goto('/admin');
    await page.getByTestId('org-e2e').locator('a').first().click();
    await page.getByTestId('org-section-people').click();
    const email = `lifecycle-${Date.now().toString(36)}@example.com`;
    await page.locator('[data-testid=invite-person][data-hydrated]').click();
    await page.getByTestId('invite-email').fill(email);
    await page.getByTestId('invite-submit').click();
    const text = await page.getByTestId('invite-link').textContent();
    const link = text!.match(/http[^\s]+/)![0]!;
    const api = await request.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const accepted = await api.post('/api/auth/invite/accept', {
        data: { token: new URL(link).searchParams.get('token'), password: PASSWORD },
      });
      expect(accepted.ok()).toBe(true);
    } finally {
      await api.dispose();
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await page.getByTestId(`user-${email}`).getByRole('link', { name: 'Manage →' }).click();
    for (const label of ['Suspend', 'Restore']) {
      await page.getByTestId(`toggle-${email}`).click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-accept').click();
      await expect(page.getByTestId(`toggle-${email}`)).toHaveText(
        label === 'Suspend' ? 'Restore' : 'Suspend',
      );
    }
    await page.getByTestId(`delete-${email}`).click();
    await page.getByTestId('confirm-accept').click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByTestId(`user-${email}`)).toHaveCount(0);
  });

  test('an organization can be created and given different limits', async ({ page }) => {
    const slug = `acme-${Date.now().toString(36)}`;
    await page.goto('/admin');

    await page.getByTestId('new-org-name').fill(slug);
    await page.getByTestId('new-org-submit').click();
    await expect(page.getByTestId(`org-${slug}`)).toBeVisible();

    await page.getByTestId(`org-${slug}`).locator('a').first().click();
    await page.waitForURL(/\/admin\/orgs\/[0-9a-f-]{36}$/);

    await page.getByTestId('org-section-limits').click();
    await page.getByTestId('quota-rendersPerDay').fill('7');
    await page.getByTestId('quota-save').click();
    await expect(page.getByTestId('quota-saved')).toBeVisible();

    await page.goto('/admin');
    await expect(page.getByTestId(`org-${slug}`)).toContainText('7');
  });

  test('someone can be invited, and the page says no email went when none did', async ({
    page,
  }) => {
    await page.goto('/admin');
    await page.getByTestId('org-e2e').locator('a').first().click();
    await page.getByTestId('org-section-people').click();

    const email = `invited-${Date.now().toString(36)}@example.com`;
    await page.locator('[data-testid=invite-person][data-hydrated]').click();
    await page.getByTestId('invite-email').fill(email);
    await page.getByTestId('invite-submit').click();

    // Never "sent" unless it was: here the development mailbox kept it.
    await expect(page.getByTestId('invite-outcome')).toContainText('no email was sent');
    // The link itself only because development tooling is on; production never shows the inviter it.
    await expect(page.getByTestId('invite-link')).toContainText('/invite/accept?token=');
    await expect(page.getByTestId('org-users')).toContainText(email);
  });

  test('an invitation not yet accepted can be resent or revoked, not suspended', async ({
    page,
  }) => {
    await page.goto('/admin');
    await page.getByTestId('org-e2e').locator('a').first().click();
    await page.getByTestId('org-section-people').click();

    const email = `pending-${Date.now().toString(36)}@example.com`;
    await page.locator('[data-testid=invite-person][data-hydrated]').click();
    await page.getByTestId('invite-email').fill(email);
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId(`user-${email}`)).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId(`user-${email}`).getByRole('link', { name: 'Manage →' }).click();

    // There is no session to end and no work to keep: suspending and deleting are the wrong verbs.
    await expect(page.getByTestId(`toggle-${email}`)).toHaveCount(0);
    await expect(page.getByTestId(`delete-${email}`)).toHaveCount(0);

    await page.getByTestId(`resend-${email}`).click();
    await expect(page.getByTestId(`resend-link-${email}`)).toContainText('/invite/accept?token=');

    await page.getByTestId(`revoke-${email}`).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('stops working');
    await page.getByTestId('confirm-accept').click();
    await expect(page.getByTestId(`user-${email}`)).toHaveCount(0);
  });

  test('a role change asks first, says what it means, and Cancel changes nothing', async ({
    page,
  }) => {
    await page.goto('/admin');
    await page.getByTestId('org-e2e').locator('a').first().click();
    await page.getByTestId('org-section-people').click();

    const email = `promoted-${Date.now().toString(36)}@example.com`;
    await page.locator('[data-testid=invite-person][data-hydrated]').click();
    await page.getByTestId('invite-email').fill(email);
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId(`user-${email}`)).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId(`user-${email}`).getByRole('link', { name: 'Manage →' }).click();
    const role = page.getByTestId(`role-${email}`);
    await expect(role).toHaveValue('member');

    // Cancel: nothing changes, and the select goes back to what is stored.
    await role.selectOption('staff');
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText(`Change ${email} from member to staff?`);
    await expect(page.getByTestId('confirm-consequences')).toContainText('admin console');
    await page.getByTestId('confirm-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(role).toHaveValue('member');

    // Escape is a cancel too.
    await role.selectOption('owner');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(role).toHaveValue('member');

    await role.selectOption('owner');
    await expect(page.getByTestId('confirm-consequences')).toContainText('anyone in');
    await page.getByTestId('confirm-accept').click();
    await expect(role).toHaveValue('owner');
  });

  test('your own row offers no way to change your role, suspend or delete yourself', async ({
    page,
  }) => {
    await page.goto('/admin');
    await page.getByTestId('org-e2e').locator('a').first().click();
    await page.getByTestId('org-section-people').click();

    // The suite's staff account belongs to this organisation; its row is the one marked "you".
    const mine = page.getByTestId('org-users').locator('tr', { has: page.locator('.chip') });
    await expect(mine).toHaveCount(1);
    await mine.getByRole('link', { name: 'Manage →' }).click();
    const controls = page.getByTestId('person-controls').locator('tbody tr');
    await expect(controls.locator('select')).toHaveCount(0);
    await expect(controls).toContainText('staff');
    await expect(controls.getByRole('button')).toHaveCount(0);
  });

  test('the audit log records what staff did', async ({ page }) => {
    // Its own organisation: lowering a limit on the one every other spec renders against would
    // quietly starve them, and a test that breaks its neighbours is worse than no test.
    const slug = `audited-${Date.now().toString(36)}`;
    await page.goto('/admin');
    await page.getByTestId('new-org-name').fill(slug);
    await page.getByTestId('new-org-submit').click();
    await page.getByTestId(`org-${slug}`).locator('a').first().click();

    await page.getByTestId('org-section-limits').click();
    await page.getByTestId('quota-maxConcurrentJobs').fill('2');
    await page.getByTestId('quota-save').click();
    await expect(page.getByTestId('quota-saved')).toBeVisible();

    await page.getByTestId('org-section-activity').click();
    await expect(page.getByTestId('org-audit')).toContainText('org.quotas_changed');
  });

  test('the queue can be watched and filtered', async ({ page }) => {
    await page.goto('/admin/queue');

    await expect(page.getByTestId('queue')).toBeVisible();
    await expect(page.getByTestId('queue-stats')).toBeVisible();

    await page.getByTestId('queue-filter-failed').click();
    await page.waitForURL(/status=failed/);
    // Either there are failures to show or there are none; both are a working filter.
    const rows = page.getByTestId('job-table').locator('tbody tr');
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute('data-status', 'failed');
    }
  });

  test('people can be found by address across organizations', async ({ page }) => {
    await page.goto('/admin/users?q=suite-');
    await expect(page).toHaveURL(/\/admin\?q=suite-/);
    await page.getByTestId('user-search').fill('suite-');
    await page.getByTestId('user-search').press('Enter');

    await expect(page.getByTestId('user-table')).toContainText('suite-');
    await expect(page.getByTestId('user-table').locator('select, button')).toHaveCount(0);
    await page
      .getByTestId('user-table')
      .getByRole('link', { name: 'Open person →' })
      .first()
      .click();
    await expect(page.getByTestId('org-person')).toBeVisible();
    await expect(page.getByTestId('org-section-people')).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('as an ordinary account', () => {
  test.use({ storageState: STORAGE_STATE });

  test('the console is not there', async ({ page }) => {
    await page.goto('/designs');
    await expect(page.getByTestId('admin-link')).toHaveCount(0);

    // Signed in, but not staff: the console answers as if the path did not exist.
    const response = await page.goto('/admin');
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId('admin')).toHaveCount(0);
  });

  test('the admin API refuses it, in the same words it refuses a stranger', async ({ page }) => {
    await page.goto('/designs');
    const status = await page.evaluate(() => fetch('/api/admin/orgs').then((r) => r.status));
    expect(status).toBe(404);
  });
});
