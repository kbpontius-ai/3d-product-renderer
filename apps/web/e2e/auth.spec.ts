import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createAccount, invite as inviteAddress, PASSWORD } from './helpers';

/**
 * The account lifecycle through the browser (W-01, W-02).
 *
 * Invitations and reset links are obtained through the development endpoints — the stand-ins for
 * the admin console and a real mailbox — and everything after that happens the way a person
 * experiences it: a link, a password form, a session cookie.
 */

test.describe.configure({ mode: 'serial' });
test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');

const NEW_PASSWORD = 'Sheen-Matte-Bevel-4407';

const email = `e2e-${randomBytes(6).toString('hex')}@example.com`;

const invite = (request: APIRequestContext, address = email) => inviteAddress(request, address);

/** Newest link of a given kind from the development mailbox. */
async function lastLink(request: APIRequestContext, template: string): Promise<string> {
  const response = await request.get('/api/dev/mail');
  const { messages } = (await response.json()) as {
    messages: { template: string; vars: { url?: string } }[];
  };
  const message = messages.find((m) => m.template === template);
  expect(message, `no ${template} message was sent`).toBeTruthy();
  return message!.vars.url!;
}

async function signIn(page: Page, address: string, password: string) {
  await page.goto('/signin');
  await page.getByTestId('email').fill(address);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();
}

test('an invitation link leads to setting a password and being signed in', async ({ page, request }) => {
  const token = await invite(request);

  await page.goto(`/invite/accept?token=${token}`);
  await expect(page.getByTestId('accept-form')).toBeVisible();

  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('confirm').fill(PASSWORD);
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('account')).toBeVisible();
  await expect(page.getByTestId('account-email')).toHaveText(email);
  await expect(page.getByTestId('account-role')).toHaveText('owner');
});

test('the same invitation link cannot be used twice', async ({ page, request }) => {
  const token = await invite(request, `twice-${randomBytes(4).toString('hex')}@example.com`);

  await page.goto(`/invite/accept?token=${token}`);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('confirm').fill(PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('account')).toBeVisible();

  await page.goto(`/invite/accept?token=${token}`);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('confirm').fill(PASSWORD);
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('auth-error')).toContainText('no longer valid');
});

test('a weak password is refused with advice, not jargon', async ({ page, request }) => {
  const token = await invite(request, `weak-${randomBytes(4).toString('hex')}@example.com`);

  await page.goto(`/invite/accept?token=${token}`);
  await page.getByTestId('password').fill('password1234');
  await page.getByTestId('confirm').fill('password1234');
  await page.getByTestId('submit').click();

  // The message names what is wrong with *this* password rather than reciting the rules.
  await expect(page.getByTestId('auth-error')).toContainText('commonly used');
});

test('signing in and out works, and a signed-out visitor is sent to sign in', async ({ page }) => {
  await signIn(page, email, PASSWORD);
  await expect(page.getByTestId('account-email')).toHaveText(email);

  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('signin-form')).toBeVisible();

  await page.goto('/account');
  await expect(page).toHaveURL(/\/signin/);
});

test('a wrong password says the same thing as an unknown address', async ({ page }) => {
  await signIn(page, email, 'Definitely-Not-It-1234');
  const wrongPassword = await page.getByTestId('auth-error').textContent();

  await signIn(page, `nobody-${randomBytes(4).toString('hex')}@example.com`, 'Definitely-Not-It-1234');
  const unknownAddress = await page.getByTestId('auth-error').textContent();

  expect(wrongPassword).toBe(unknownAddress);
});

test('a password reset ends every session', async ({ page, context, request }) => {
  await signIn(page, email, PASSWORD);
  await expect(page.getByTestId('account')).toBeVisible();

  // Ask for a reset the way a user would, then read the link out of the development mailbox.
  await page.goto('/reset');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('reset-sent')).toBeVisible();

  const resetUrl = await lastLink(request, 'password-reset');
  expect(resetUrl).toContain('/reset?token=');

  const resetPage = await context.newPage();
  await resetPage.goto(resetUrl);
  await resetPage.getByTestId('password').fill(NEW_PASSWORD);
  await resetPage.getByTestId('submit').click();
  await expect(resetPage.getByTestId('signin-form')).toBeVisible();
  await resetPage.close();

  // The original session is gone, and only the new password works.
  await page.goto('/account');
  await expect(page).toHaveURL(/\/signin/);

  await signIn(page, email, NEW_PASSWORD);
  await expect(page.getByTestId('account-email')).toHaveText(email);
});

test('the forgot-password screen never reveals whether an address exists', async ({ page }) => {
  await page.goto('/reset');
  await page.getByTestId('email').fill(`ghost-${randomBytes(4).toString('hex')}@example.com`);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('reset-sent')).toContainText('If that address has an account');
});

test('the catalog shows what pack import put in the database', async ({ page, request }) => {
  await createAccount(page, request);
  await page.goto('/catalog');

  await expect(page.getByTestId('catalog')).toBeVisible();
  // Both fixture packs are imported by the e2e setup: a closure and a carton, same code path.
  await expect(page.getByTestId('product-cap-basic-cap-flat')).toContainText('Top face');
  await expect(page.getByTestId('product-box-basic-carton-tuck')).toContainText('Front panel');
});

test('the catalog is not visible to a signed-out visitor', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/catalog');
  await expect(page).toHaveURL(/\/signin/);
});

test('a password that looks strong but is guessable is refused, with advice', async ({ page, request }) => {
  const address = `weak-${Date.now().toString(36)}@example.com`;
  const token = await invite(request, address);

  await page.goto(`/invite/accept?token=${token}`);
  // Upper, lower, digit and symbol — and the first thing anyone would try.
  await page.getByTestId('password').fill('P@ssw0rd2024!');
  await page.getByTestId('confirm').fill('P@ssw0rd2024!');
  await page.getByTestId('submit').click();

  // Leet substitutions do not hide a dictionary word from an estimator that undoes them.
  await expect(page.getByTestId('auth-error')).toContainText('easier to guess');

  // A passphrase gets in, with none of those character classes.
  await page.getByTestId('password').fill('chamfer ridge lantern quarry');
  await page.getByTestId('confirm').fill('chamfer ridge lantern quarry');
  await page.getByTestId('submit').click();
  // Accepting an invitation lands on the account page, signed in.
  await page.waitForURL(/\/account/);
  await expect(page.getByTestId('account-email')).toHaveText(address);
});

test('every page carries a nonce policy that its own scripts satisfy (docs/05-security.md)', async ({ page }) => {
  // Checked on a page that must work without a session and on one that must work with one, because
  // the nonce comes from middleware and the failure mode is per-render: a page whose HTML was built
  // rather than rendered has script tags no nonce ever reached, and it serves, paints, and then
  // does nothing at all when clicked.
  for (const path of ['/signin', '/design/demo']) {
    const response = await page.goto(path);
    const csp = response?.headers()['content-security-policy'] ?? '';

    // Scoped to `script-src`, because the one permitted inline is `style-src-attr`: React writes
    // `style={{…}}` as an attribute and attributes have no nonce. Asserting the whole policy is
    // free of the string would fail on that deliberate exception and teach whoever hits it to
    // delete the assertion.
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc, `${path} has no script-src`).not.toBe('');
    expect(scriptSrc, `${path} allows inline script`).not.toContain("'unsafe-inline'");
    expect(scriptSrc, `${path} allows eval`).not.toContain("'unsafe-eval'");
    expect(scriptSrc, `${path} has no nonce`).toMatch(/'nonce-[a-f0-9]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');

    const nonce = /'nonce-([a-f0-9]+)'/.exec(scriptSrc)![1];
    const scripts = await page.locator('script').evaluateAll(
      (nodes, expected) =>
        nodes.map((n) => ({
          nonced: (n as HTMLScriptElement).nonce === expected || n.getAttribute('nonce') === expected,
          src: (n as HTMLScriptElement).src,
        })),
      nonce,
    );

    expect(scripts.length, `${path} rendered no scripts at all`).toBeGreaterThan(0);
    // Every one of them, because one unnonced inline script is the whole policy defeated: the
    // browser blocks it and the page is broken, or `unsafe-inline` creeps back to unbreak it.
    expect(
      scripts.filter((s) => !s.nonced),
      `${path} has scripts the policy would block`,
    ).toEqual([]);
  }

  // And the page is not merely serving — it is running, which is the thing a wrong policy breaks.
  await page.goto('/design/demo');
  await expect(page.getByTestId('mode-place')).toBeVisible();
});
