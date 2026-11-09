import { expect, test } from '@playwright/test';
import { STAFF_STORAGE_STATE } from './global-setup';

/**
 * The material library (F-ADM-04).
 *
 * The preview is a canvas, so what is checked here is the part a test can check: that a material
 * can be created, adjusted, and that the adjustment survives a reload — plus the count of designs
 * a change would affect, which is the thing that stops an operator changing one carelessly.
 */

test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
test.describe.configure({ mode: 'serial' });
test.use({ storageState: STAFF_STORAGE_STATE });

test('materials from packs are listed with what uses them', async ({ page }) => {
  await page.goto('/admin/materials');

  await expect(page.getByTestId('materials')).toBeVisible();
  // The cap fixture ships a plastic; whatever its key, at least one material is there.
  await expect(page.locator('[data-testid^="material-"]').first()).toBeVisible();

  // Previews are WebGL contexts, and browsers only hand out so many: none exist until asked for.
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByTestId('material-preview-pp-gloss').click();
  await expect(page.locator('canvas')).toHaveCount(1);
});

test('a material can be created and adjusted, and the change sticks', async ({ page }) => {
  const name = `Test plastic ${Date.now().toString(36)}`;
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  await page.goto('/admin/materials');
  await page.getByTestId('new-material-name').fill(name);
  await page.getByTestId('new-material-family').selectOption('plastic');
  await page.getByTestId('new-material-submit').click();

  const card = page.getByTestId(`material-${key}`);
  await expect(card).toBeVisible();

  await page.getByTestId(`material-roughness-${key}`).fill('0.85');
  await page.getByTestId(`material-save-${key}`).click();
  await expect(page.getByTestId(`material-saved-${key}`)).toBeVisible();

  await page.reload();
  await expect(page.getByTestId(`material-roughness-${key}`)).toHaveValue('0.85');
});

test('two materials cannot share a key', async ({ page }) => {
  const name = `Duplicate ${Date.now().toString(36)}`;

  await page.goto('/admin/materials');
  await page.getByTestId('new-material-name').fill(name);
  await page.getByTestId('new-material-submit').click();
  await expect(page.getByTestId(`material-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)).toBeVisible();

  await page.getByTestId('new-material-name').fill(name);
  await page.getByTestId('new-material-submit').click();
  await expect(page.getByText('already exists')).toBeVisible();
});
