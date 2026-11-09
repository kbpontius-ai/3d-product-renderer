/**
 * Captures the editor for review. Usage:
 *   pnpm --filter @pr/web exec next start --port 3100 &
 *   pnpm tsx scripts/screenshot.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { confirmPreparation } from '../apps/web/e2e/helpers';

async function main() {
  const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
  const OUT = join(process.cwd(), 'docs', 'screenshots');
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  await page.goto(`${BASE}/design/demo`);
  await page.waitForSelector('[data-testid="face-view-canvas"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scale-chip"]')?.textContent !== '—',
  );
  await page.waitForTimeout(400); // first shading pass

  await page.screenshot({ path: join(OUT, 'editor-cap-deboss.png') });

  // Deeper relief, drag off-centre to show a live snap guide.
  await page.getByTestId('depth-slider').fill('0.55');
  const box = (await page.getByTestId('face-view-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 3, { steps: 6 });
  await page.screenshot({ path: join(OUT, 'editor-snap-guide.png') });
  await page.mouse.up();

  // The carton panel: a different pack, a different zone type, same editor.
  await page.getByTestId('zone-front').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'editor-carton-print.png') });

  // A real SVG upload, taken through sanitise -> normalise -> raster -> distance field in the tab.
  await page.getByTestId('zone-top').click();
  await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
  await confirmPreparation(page);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT, 'editor-uploaded-svg.png') });

  // The account lifecycle and catalog, when a database is configured.
  if (process.env['DEV_TOOLING'] === 'true') {
    const api = await browser.newContext({ baseURL: BASE });
    const invitePage = await api.newPage();
    const address = `shot-${Date.now()}@example.com`;
    const invited = await invitePage.request.post('/api/dev/invite', {
      data: { email: address, orgSlug: 'e2e' },
    });
    const { token } = (await invited.json()) as { token: string };

    await invitePage.setViewportSize({ width: 1440, height: 900 });
    await invitePage.goto(`${BASE}/invite/accept?token=${token}`);
    await invitePage.screenshot({ path: join(OUT, 'invite-accept.png') });

    await invitePage.getByTestId('password').fill('Chamfer-Ink-Ridge-8821');
    await invitePage.getByTestId('confirm').fill('Chamfer-Ink-Ridge-8821');
    await invitePage.getByTestId('submit').click();
    await invitePage.waitForSelector('[data-testid="account"]');

    await invitePage.goto(`${BASE}/catalog`);
    await invitePage.waitForSelector('[data-testid="catalog"]');
    await invitePage.screenshot({ path: join(OUT, 'catalog.png') });

    // A design, opened from the catalog and autosaved.
    await invitePage.getByTestId('start-cap-flat-38mm').click();
    await invitePage.waitForURL(/\/design\/[0-9a-f-]{36}$/);
    await invitePage.waitForSelector('[data-testid="face-view-canvas"]');
    await invitePage.waitForFunction(
      () =>
        document.querySelector('[data-testid="save-status"]')?.getAttribute('data-status') ===
        'saved',
      undefined,
      { timeout: 30_000 },
    );
    await invitePage.screenshot({ path: join(OUT, 'design-saved.png') });

    await invitePage.goto(`${BASE}/designs`);
    await invitePage.waitForSelector('[data-testid="design-list"]');
    await invitePage.screenshot({ path: join(OUT, 'designs.png') });
    await api.close();
  }

  await browser.close();
  console.log(`screenshots written to ${OUT}`);
}

void main();
