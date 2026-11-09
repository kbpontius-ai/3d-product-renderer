import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { MEMBER_EMAIL_FILE, PASSWORD, STORAGE_STATE } from './global-setup';

/**
 * Organisation self-service (W-16, F-ORG-01..05).
 *
 * The suite's shared account is an owner, which is what this area is for. The interesting half is
 * what a *member* gets, so this spec makes one: an owner invites them, they accept, and then every
 * door is tried from their side.
 */

test.describe.configure({ mode: 'serial' });
test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');

/**
 * The member this file administers, provisioned once by `global-setup`.
 *
 * Not created here. Accepting an invitation is capped at ten per ten minutes per IP, and the whole
 * suite shares one — a spec that mints its own account spends that budget every run, which is how
 * an earlier draft of this file broke `designs.spec.ts` rather than itself.
 */
let memberEmail = '';
let memberId = '';

test.beforeAll(async ({ browser }) => {
  if (process.env['DEV_TOOLING'] !== 'true') return;

  memberEmail = (await readFile(MEMBER_EMAIL_FILE, 'utf8')).trim();

  const owner = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await owner.newPage();
  await page.goto('/org/people');
  const row = page.locator('[data-testid^="member-"][data-status]').filter({ hasText: memberEmail });
  await expect(row).toHaveCount(1);
  memberId = (await row.getAttribute('data-testid'))!.replace('member-', '');
  await owner.close();
});

test.describe('as an owner', () => {
  test.use({ storageState: STORAGE_STATE });

  test('the organization area is reachable and scoped to one organization', async ({ page }) => {
    await page.goto('/org');
    await expect(page.getByTestId('org-overview')).toBeVisible();
    await expect(page.getByTestId('stat-seats')).not.toBeEmpty();

    await page.getByTestId('org-nav-people').click();
    await expect(page.getByTestId('member-table')).toBeVisible();
  });

  test('invites somebody, and offers only the two roles an owner may grant', async ({ page }) => {
    // Issuing an invitation is not what the rate limit counts — accepting one is — so this proves
    // the form without spending the suite's budget on another account.
    await page.goto('/org/people');
    await expect(page.getByTestId('org-invite-role')).toHaveValue('member');
    const options = await page.getByTestId('org-invite-role').locator('option').allTextContents();
    expect(options.map((o) => o.toLowerCase())).toEqual(['member', 'owner']);

    const invited = `invited-${Date.now()}@example.com`;
    await page.getByTestId('org-invite-email').fill(invited);
    await page.getByTestId('org-invite-submit').click();
    // Development keeps mail in the local mailbox, and the form says so instead of claiming it sent.
    await expect(page.getByTestId('invite-outcome')).toContainText('no email was sent');
    await expect(page.getByTestId('org-invite-link')).toContainText('/invite/accept');

    // Somebody who has not accepted can be sent the link again, or have it taken back.
    await page.getByTestId(`resend-${invited}`).click();
    await expect(page.getByTestId(`resend-link-${invited}`)).toContainText('/invite/accept');
    await page.getByTestId(`revoke-${invited}`).click();
    await page.getByTestId('confirm-accept').click();
    await expect(page.getByTestId(`resend-${invited}`)).toHaveCount(0);
    await expect(page.getByTestId('member-table')).not.toContainText(invited);
  });

  test('offers no way to delete anybody', async ({ page }) => {
    // Deliberate: suspension is reversible and keeps their work, and it is what an owner needs.
    await page.goto('/org/people');
    await expect(page.getByRole('button', { name: /delete|remove/i })).toHaveCount(0);
  });

  test('quotas are shown, not editable', async ({ page }) => {
    await page.goto('/org');
    await expect(page.getByTestId('stat-renders')).toBeVisible();
    await expect(page.getByRole('button', { name: /save quota|update quota/i })).toHaveCount(0);
  });

  test('suspends a member and reinstates them', async ({ page }) => {
    await page.goto('/org/people');

    // It asks first, and says what suspending does; cancelling leaves them as they were.
    await page.getByTestId(`member-suspend-${memberId}`).click();
    await expect(page.getByTestId('confirm-consequences')).toContainText('signed out everywhere');
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId(`member-status-${memberId}`)).toHaveText('active');

    await page.getByTestId(`member-suspend-${memberId}`).click();
    await page.getByTestId('confirm-accept').click();
    await expect(page.getByTestId(`member-status-${memberId}`)).toHaveText('suspended');

    await page.getByTestId(`member-suspend-${memberId}`).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Restore');
    await page.getByTestId('confirm-accept').click();
    await expect(page.getByTestId(`member-status-${memberId}`)).toHaveText('active');
  });

  test('withholds a product from a member, and gives it back', async ({ page }) => {
    await page.goto(`/org/people/${memberId}`);
    await expect(page.getByTestId('access-list')).toBeVisible();

    // Scoped to the checkboxes: `access-list`, `access-error` and `access-not-applicable` share the
    // prefix, and a bare `^="access-"` picks up the container before any of the controls.
    const box = () => page.locator('[data-testid="access-list"] input[type="checkbox"]').first();
    await expect(box()).toBeChecked();

    // Waiting on the request, not on the tick. The box moves optimistically the moment it is
    // clicked, so navigating on the click alone races the write that the next page reads.
    const saved = () =>
      page.waitForResponse((r) => r.url().includes('/access') && r.request().method() === 'PUT');

    await Promise.all([saved(), box().uncheck()]);

    // The catalog view is the same fact from the other side.
    await page.goto('/org/catalog');
    await expect(page.getByTestId('org-catalog-table')).toContainText(memberEmail);

    await page.goto(`/org/people/${memberId}`);
    await Promise.all([saved(), box().check()]);
    await page.goto('/org/catalog');
    await expect(page.getByTestId('org-catalog-table')).not.toContainText(memberEmail);
  });

  test('an owner is not offered per-product access at all', async ({ page }) => {
    await page.goto('/org/people');
    const owners = page.locator('tr').filter({ hasText: 'owner' }).first();
    const id = (await owners.getAttribute('data-testid'))?.replace('member-', '');
    expect(id, 'the provisioned organisation must have an owner').toBeTruthy();

    await page.goto(`/org/people/${id}`);
    await expect(page.getByTestId('access-not-applicable')).toBeVisible();
    await expect(page.getByTestId('access-list')).toHaveCount(0);
  });

  test('records what it did', async ({ page }) => {
    await page.goto('/org/activity');
    await expect(page.getByTestId('org-activity-table')).toContainText('org.access');
  });
});

test.describe('as a member', () => {
  test('cannot reach any of it, and is told the area does not exist', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/signin');
    await page.getByTestId('email').fill(memberEmail);
    await page.getByTestId('password').fill(PASSWORD);
    await page.getByTestId('submit').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'));

    // 404 rather than 403: whether this organisation has an administration area is not something a
    // member learns from an error code.
    for (const path of ['/org', '/org/people', '/org/catalog', '/org/activity']) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should not exist for a member`).toBe(404);
    }

    /*
     * And the API refuses too — a guard on the page alone leaves the endpoint open.
     *
     * Fetched from inside the page rather than through Playwright's request context: the session is
     * a cookie, and the request context does not carry it, so that route answers 401 for the wrong
     * reason and would pass this test while proving nothing about the role check. This is also the
     * path a signed-in attacker actually has.
     */
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/org/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.com', role: 'owner' }),
      });
      return response.status;
    });
    expect(status).toBe(404);

    await context.close();
  });
});
