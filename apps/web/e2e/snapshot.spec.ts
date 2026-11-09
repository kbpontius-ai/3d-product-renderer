import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { STORAGE_STATE } from './global-setup';

test.use({ timezoneId: 'America/Denver' });

async function viewerReady(page: Page) {
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('viewport-loading')).toHaveCount(0);
  await expect(page.getByTestId('viewport-3d').locator('canvas')).toHaveAttribute(
    'data-capture-ready', 'true',
  );
}

async function snapshot(page: Page) {
  await viewerReady(page);
  const downloaded = page.waitForEvent('download');
  const expected = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="viewport-3d"] canvas')!;
    const data = canvas.toDataURL('image/png');
    const dimensions = { width: canvas.width, height: canvas.height };
    document.querySelector<HTMLButtonElement>('[data-testid="snapshot-button"]')!.click();
    return { data, ...dimensions };
  });
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(16)).toBe(expected.width);
  expect(bytes.readUInt32BE(20)).toBe(expected.height);
  expect(bytes.equals(Buffer.from(expected.data.split(',')[1]!, 'base64'))).toBe(true);
  expect(bytes.length).toBeGreaterThan(1000);
  return { download, bytes };
}

test('Snapshot downloads exactly the current viewer without queuing or uploading', async ({ page }, info) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\//.test(request.url())) writes.push(request.url());
  });
  await page.goto('/design/demo');
  await page.clock.setFixedTime(new Date('2026-10-24T00:34:56.789Z'));
  const first = await snapshot(page);
  expect(first.download.suggestedFilename()).toBe('viewer-snapshot-2026-10-23_18-34-56-789.png');
  await first.download.saveAs(info.outputPath('snapshot.png'));
  await page.screenshot({ path: info.outputPath('snapshot-toolbar.png') });
  await page.getByTestId('background-solid').click();
  await page.getByTestId('background-color').fill('#b53c73');
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.clock.setFixedTime(new Date('2026-10-24T00:34:56.790Z'));
  const second = await snapshot(page);
  expect(second.download.suggestedFilename()).toBe('viewer-snapshot-2026-10-23_18-34-56-790.png');
  expect(second.bytes.equals(first.bytes)).toBe(false);
  expect(writes).toEqual([]);
});

test('Snapshot is disabled in Place and captures only the 3D viewer in Split', async ({ page }) => {
  await page.goto('/design/demo');
  await page.locator('.editor[data-hydrated]').waitFor();
  for (let round = 0; round < 3; round++) {
    await page.getByTestId('mode-place').click();
    await expect(page.getByTestId('snapshot-button')).toBeDisabled();
    await expect(page.getByTestId('snapshot-button')).toHaveAttribute('title', /Switch to Viewer or Split/);
    await page.getByTestId('mode-split').click();
    await expect(page.getByTestId('snapshot-button')).toBeEnabled();
    await expect(page.getByTestId('face-view-canvas')).toBeVisible();
    await snapshot(page);
    await page.getByTestId('inspection-rotation').fill(String(round * 20));
    await snapshot(page);
    await expect(page.getByTestId('snapshot-error')).toHaveCount(0);
  }
});

test('failed PNG encoding shows an error and permits a successful retry', async ({ page }) => {
  await page.goto('/design/demo');
  await viewerReady(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    let fail = true;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      if (fail && this.closest('[data-testid="viewport-3d"]')) {
        fail = false;
        callback(null);
      } else original.call(this, callback, ...args);
    };
  });
  await page.getByTestId('snapshot-button').click();
  await expect(page.getByTestId('snapshot-error')).toContainText('Could not capture the viewer');
  await expect(page.getByTestId('snapshot-button')).toBeEnabled();
  await snapshot(page);
  await expect(page.getByTestId('snapshot-error')).toHaveCount(0);
});

test('loading geometry produces an understandable error rather than a blank download', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/*.glb', async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto('/design/demo');
    await page.getByTestId('snapshot-button').click();
    await expect(page.getByTestId('snapshot-error')).toContainText('viewer is still loading');
  } finally { release(); }
  await snapshot(page);
});

test.describe('saved designs', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'requires isolated account database');
  test.use({ storageState: STORAGE_STATE });

  test('Snapshot works without placed artwork and uses the design name', async ({ page }) => {
    await page.goto('/catalog');
    await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
    await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
    const name = await page.locator('.brand strong').textContent();
    const writes: string[] = [];
    await viewerReady(page);
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/renders')) writes.push(request.url());
    });
    const result = await snapshot(page);
    const stem = name!.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    expect(result.download.suggestedFilename().startsWith(`${stem}-snapshot-`)).toBe(true);
    expect(result.download.suggestedFilename()).toMatch(/-snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.png$/);
    expect(writes).toEqual([]);
  });
});
