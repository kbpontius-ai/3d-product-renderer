/**
 * Puts the preview and the renderer side by side (docs/20-testing-ci.md, parity).
 *
 * Drives the demo editor in a real browser, uploads a piece of artwork, and captures the 2D face
 * view and the 3D preview from a named camera preset. Render the same design with
 * `pnpm render:sample` and the two images should agree — that agreement is the product.
 *
 *   ARTWORK=fixtures/artwork/samples/wordmark.svg PRESET="Logo close-up" OUT=.tmp/preview.png \
 *     pnpm preview:probe
 */
import { chromium } from '@playwright/test';
import { confirmPreparation } from '../apps/web/e2e/helpers';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

async function main() {
  // `CHROMIUM_PATH` as everywhere else: unset keeps the CI image's browser, an empty string means
  // Playwright's own download. Hardcoding the image path made this script — the one the working
  // agreement asks for whenever the viewport might have moved — impossible to run anywhere else.
  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(
    chromiumPath === '' ? {} : { executablePath: chromiumPath },
  );
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const out = process.env.OUT ?? '.tmp/preview.png';
  await page.goto(`${BASE}/design/demo`);
  await page
    .getByTestId('artwork-upload')
    .setInputFiles(process.env.ARTWORK ?? '.tmp/probe-art/corner.svg');
  await confirmPreparation(page);
  await page.waitForTimeout(2500);

  // Face view first: this is what the user drags in, and the ground truth for orientation.
  await page.getByTestId('mode-place').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('face-view-canvas').screenshot({ path: out.replace('.png', '-face.png') });

  await page.getByTestId('mode-look').click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: process.env.PRESET ?? 'Top', exact: true }).click();
  await page.waitForTimeout(6000);
  await page.locator('canvas').last().screenshot({ path: out });

  await browser.close();
  console.log(`wrote ${out} and its -face companion`);
}

void main();
