import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against a production build of the web app: the same bundle CI ships, and the same
 * fixture packs the conformance suite uses.
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  globalSetup: './apps/web/e2e/global-setup.ts',
  fullyParallel: true,
  // These share a machine with a path tracer and a database; a five-second default measures the
  // box rather than the app.
  expect: { timeout: 15_000 },
  /*
   * And the same reasoning for the whole test, which had been left at the 30-second default.
   *
   * The relief tests are the ones that do not fit in it: each round is an upload, a shader compile,
   * a poll of up to 20 s for the patch to appear and a 4-second settle before any pixel is read,
   * and `deepens the relief when the depth control is turned up` does that round twice. It takes
   * 26.7 s on a developer machine with a GPU and 24.9 s with Chromium forced onto its software
   * rasteriser — inside 30 s both times, but by a margin no CI runner was ever going to keep. On a
   * two-vCPU runner sharing those cores between parallel workers it does not, and the failure is
   * `page.waitForTimeout: Test timeout of 30000ms exceeded` on a fixed sleep, which says nothing
   * about the app at all.
   *
   * A cap still exists to stop a genuinely hung test running forever. It just has to be a cap on
   * hanging rather than a cap on being slower than this laptop.
   */
  timeout: process.env.CI ? 120_000 : 60_000,
  /*
   * Limits on the run as a whole, CI only. A breakage that every test meets — a canvas that takes
   * longer to appear than the expect timeout — costs each test that timeout twice, the second time
   * on retry, so the suite crawls on for an hour reporting the same failure. Ten failures is well
   * past anything flaky and stops a run like that in minutes. The global limit ends a slow e2e run
   * cleanly, with its report, before the job's own limit in ci.yml kills it without one.
   */
  maxFailures: process.env.CI ? 10 : 0,
  globalTimeout: process.env.CI ? 25 * 60_000 : 0,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.CHROMIUM_PATH === ''
          ? {}
          : {
              launchOptions: {
                executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
              },
            }),
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @pr/web exec next start --port 3100',
    url: 'http://127.0.0.1:3100/design/demo',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Explicitly empty rather than absent, for the path where Playwright starts the server itself
      // (CI, or `playwright test` run directly): an inherited provider key would send the suite's
      // invitations for real. `scripts/e2e.sh` unsets these too; see the note there.
      RESEND_API_KEY: '',
      MAIL_FROM: '',
      // The account tests need a database and the stand-ins for an admin console and a mailbox.
      ...(process.env['DATABASE_URL'] ? { DATABASE_URL: process.env['DATABASE_URL'] } : {}),
      APP_URL: 'http://127.0.0.1:3100',
      DEV_TOOLING: process.env['DEV_TOOLING'] ?? 'false',
      // The suite sets a password on every account it makes, and whether a breach-corpus service is
      // up and quick to answer says nothing about this code. `scripts/e2e.sh` has always turned
      // this off; this launch path never did, so CI has been calling a third party on every
      // password set — latency inside the per-test budget, and a red suite the day it is down.
      PASSWORD_BREACH_CHECK: process.env['PASSWORD_BREACH_CHECK'] ?? 'off',
      // Set explicitly so the suite exercises the configured signing path rather than the
      // per-process fallback a developer's machine falls back to.
      ASSET_URL_SECRET: process.env['ASSET_URL_SECRET'] ?? 'e2e-asset-signing-secret',
      // The suite accepts a dozen or so invitations a run from one address — global setup's three
      // shared accounts, plus every test that is *about* the account lifecycle. The production
      // default of ten per ten minutes is right for real users on their own connections and wrong
      // for one machine doing legitimate setup.
      AUTH_INVITE_ACCEPT_LIMIT: process.env['AUTH_INVITE_ACCEPT_LIMIT'] ?? '100',
      // Every spec uploads through the same shared account: more than the thirty per five minutes
      // a person gets.
      ARTWORK_UPLOAD_LIMIT: process.env['ARTWORK_UPLOAD_LIMIT'] ?? '300',
      ARTWORK_PREPARE_LIMIT: process.env['ARTWORK_PREPARE_LIMIT'] ?? '1000',
      // e2e deliberately runs a production build, so the second gate has to be acknowledged too.
      ALLOW_DEV_TOOLING_IN_PRODUCTION: process.env['DEV_TOOLING'] ?? 'false',
    },
  },
});
