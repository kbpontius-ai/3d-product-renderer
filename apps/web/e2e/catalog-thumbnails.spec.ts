import { expect, test } from '@playwright/test';
import { STAFF_STORAGE_STATE, STORAGE_STATE } from './global-setup';

test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
test.describe('Catalog preview controls (F-CAT-08)', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: STAFF_STORAGE_STATE });
  test('missing images have an explicit placeholder', async ({ page }) => {
    await page.goto('/catalog');
    await expect(
      page.getByTestId('product-cap-basic-cap-flat').locator('.product-thumb'),
    ).toHaveText('Preview not available');
  });
  test('staff can generate a preview and Catalog loads the image', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/admin/packs');
    await page
      .getByTestId('pack-cap-basic-1.0.0')
      .getByRole('link', { name: 'Catalog previews' })
      .click();
    await expect(page.getByRole('heading', { name: /Catalog previews/ })).toBeVisible();
    await page.getByRole('button', { name: 'Generate preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Capture preview', exact: true })).toBeEnabled({
      timeout: 30000,
    });
    let releaseSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route('**/api/admin/packs/*/thumbnails?variantId=*', async (route) => {
      await pendingSave;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Capture preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Close preview', exact: true })).toBeDisabled();
    releaseSave();
    await expect(page.getByTestId('preview-saved')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Regenerate preview' })).toBeEnabled();
    await page.goto('/catalog');
    const image = page.getByTestId('product-cap-basic-cap-flat').locator('img.product-thumb');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(768);
    await page
      .getByTestId('product-cap-basic-cap-flat')
      .getByTestId('start-cap-basic-cap-flat-38mm')
      .click();
    await expect(page).toHaveURL(/\/design\//);
  });
});
test.describe('Catalog preview authorization', () => {
  test.use({ storageState: STORAGE_STATE });
  test('ordinary users cannot read or enqueue thumbnail jobs', async ({ page }) => {
    await page.goto('/catalog');
    const statuses = await page.evaluate(async () => {
      const path = '/api/admin/packs/00000000-0000-7000-8000-000000000001/thumbnails';
      const read = await fetch(path);
      const write = await fetch(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return [read.status, write.status];
    });
    expect(statuses).toEqual([404, 404]);
  });
});
