import { expect, test } from '@playwright/test';
import { openEditor, confirmPreparation } from './helpers';
import { STORAGE_STATE, STAFF_STORAGE_STATE } from './global-setup';
import type { StoredArtwork } from '../lib/editor-data';

test('Viewer shows the quiet ring and measured progress while downloading the part', async ({
  page,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/fixtures/packs/**/*.glb', async (route) => {
    await waiting;
    await route.continue();
  });
  try {
    await openEditor(page);
    const loading = page.getByTestId('viewport-loading');
    await expect(loading.locator('.loading-spinner')).toBeVisible();
    await expect(loading.getByRole('progressbar')).toBeVisible();
    release();
    await expect(loading).toBeHidden();
  } finally {
    release();
  }
});


test.describe('account loading feedback', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'needs the isolated e2e database');
  test.use({ storageState: STORAGE_STATE });
  test('the artwork picker stops loading when an empty response arrives', async ({ page }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/artworks', async (route) => {
      await waiting;
      await route.fulfill({ json: { artworks: [] } });
    });
    let designId: string | undefined;
    try {
      await page.goto('/catalog');
      await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
      await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
      designId = new URL(page.url()).pathname.split('/').pop();
      await page.locator('.editor[data-hydrated]').waitFor();
      await page.getByTestId('artwork-library-toggle').click();
      const library = page.getByTestId('artwork-library');
      await expect(library.locator('.loading-spinner-compact')).toBeVisible();
      release();
      await expect(page.getByTestId('artwork-library-empty')).toBeVisible();
      await expect(library.locator('.loading-spinner')).toHaveCount(0);
    } finally {
      release();
      if (designId) await page.request.delete(`/api/designs/${designId}`);
    }
  });

  test('SVG analysis shows a compact ring, then removes it for an error with recovery actions', async ({
    page,
  }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/artworks/preparation', async (route) => {
      await waiting;
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: { detail: 'SVG analysis test failure' } }),
      });
    });
    try {
      await page.goto('/artwork');
      await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
      await page
        .getByTestId('gallery-upload-input')
        .setInputFiles('fixtures/artwork/samples/wordmark.svg');
      const preparation = page.getByTestId('artwork-preparation');
      await expect(preparation.locator('.loading-spinner-compact')).toBeVisible();
      await expect(preparation.getByText('Analyzing SVG…')).toBeVisible();
      release();
      await expect(page.getByTestId('preparation-error')).toBeVisible();
      await expect(preparation.locator('.loading-spinner')).toHaveCount(0);
      await expect(preparation.getByRole('button', { name: 'Retry analysis' })).toBeEnabled();
      await preparation.getByRole('button', { name: 'Back to artwork' }).click();
      await expect(preparation).toHaveCount(0);
    } finally {
      release();
    }
  });

  test('SVG source loading and save feedback end when their requests complete', async ({
    page,
  }) => {
    await page.goto('/artwork');
    await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/artworks/preparation') &&
        response.request().method() === 'PUT',
    );
    await page.getByTestId('gallery-upload-input').setInputFiles({
      name: `loading-${Date.now()}.svg`,
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><path d="M0 0L20 0L2 20Z"/></svg>',
      ),
    });
    await confirmPreparation(page);
    const artwork = (await (await response).json()) as StoredArtwork;
    let release!: () => void;
    let waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(artwork.sourceUrl, async (route) => {
      await waiting;
      await route.continue();
    });
    try {
      await page
        .getByTestId(`artwork-tile-${artwork.ref.artworkId}`)
        .getByRole('button')
        .first()
        .click();
      await expect(page.locator('.artwork-viewer-loading .loading-spinner')).toBeVisible();
      release();
      await expect(page.getByTestId('artwork-svg-preview')).toBeVisible();
      await expect(page.locator('.artwork-viewer-loading')).toHaveCount(0);
      waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**/api/artworks/${artwork.ref.artworkId}`, async (route) => {
        if (route.request().method() === 'PUT') {
          await waiting;
        }
        await route.continue();
      });
      await page.getByTestId('artwork-edit-width').fill('18');
      await page.getByTestId('artwork-save').click();
      await expect(
        page.getByTestId('artwork-save').locator('.loading-spinner-compact'),
      ).toBeVisible();
      await expect(page.getByTestId('artwork-save')).toBeDisabled();
      release();
      await expect(page.getByTestId('artwork-save').locator('.loading-spinner')).toHaveCount(0);
      await expect(page.getByTestId('artwork-editor-error')).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await page.request.delete(`/api/artworks/${artwork.ref.artworkId}`);
    }
  });
});

test.describe('Admin loading feedback', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'needs the isolated e2e database');
  test.use({ storageState: STAFF_STORAGE_STATE });
  test('zone preview reserves space and displays the ring while its mesh loads', async ({
    page,
  }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\.glb(?:\?|$)/, async (route) => {
      await waiting;
      await route.continue();
    });
    try {
      await page.goto('/admin/packs');
      await page.getByTestId('zones-cap-basic').click();
      const loading = page.getByTestId('zone-preview-loading');
      await expect(loading.locator('.loading-spinner')).toBeVisible();
      expect((await loading.boundingBox())!.height).toBeGreaterThanOrEqual(430);
      release();
      await expect(loading).toHaveCount(0);
      await expect(page.locator('.zone-preview canvas')).toBeVisible();
    } finally {
      release();
    }
  });
});
