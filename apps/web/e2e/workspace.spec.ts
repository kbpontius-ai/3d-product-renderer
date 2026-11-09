import { expect, test } from '@playwright/test';
import { STAFF_STORAGE_STATE, STORAGE_STATE } from './global-setup';

test.describe('Wrap workspace', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
  test.use({ storageState: STORAGE_STATE });

  test('new design chooses a product; editor navigation and settings retain their workflows', async ({ page }) => {
    await page.goto('/designs');
    await page.getByTestId('new-design').click();
    await expect(page).toHaveURL(/\/catalog$/);
    await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
    await page.locator('.editor[data-hydrated]').waitFor();
    await page.getByTestId('mode-place').click();
    await expect(page.getByTestId('face-view-canvas')).toBeVisible();
    await expect(page.getByTestId('nav-designs')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('open-render-settings').click();
    await expect(page.getByTestId('render-panel')).toBeInViewport();
    await expect(page.getByTestId('render-button')).toBeVisible();
    await expect(page.getByTestId('render-job')).toHaveCount(0);
    await page.getByTestId('nav-designs').click();
    await expect(page.getByTestId('design-list')).toBeVisible();
    await page.getByRole('textbox', { name: 'Search designs' }).fill('no-match-unique-workspace');
    await expect(page.getByTestId('design-list').locator('li')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Search designs' }).clear();
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await expect(page.getByTestId('design-list')).toHaveClass(/list/);
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    await expect(page.getByTestId('design-list')).toHaveClass(/grid/);
    await page.getByTestId('design-list').locator('summary').first().click();
    await expect(page.getByTestId('design-list').getByRole('button', { name: 'Duplicate', exact: true }).first()).toBeVisible();
    await page.getByTestId('design-list').getByRole('button', { name: 'Duplicate', exact: true }).first().click();
    await expect(page).toHaveURL(/\/design\/[0-9a-f-]{36}$/);
  });
});

test.describe('staff workspace', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
  test.use({ storageState: STAFF_STORAGE_STATE });
  test('organization filters preserve detail navigation and parent selection', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByTestId('nav-admin')).toHaveAttribute('aria-current', 'page');
    await page.getByRole('textbox', { name: 'Search organizations' }).fill('no-match-unique-workspace');
    await expect(page.getByTestId('org-table').locator('tbody tr')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Search organizations' }).clear();
    await page.getByTestId('org-table').getByRole('link').first().click();
    await expect(page.getByTestId('admin-nav-organizations')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('org-detail')).toBeVisible();
  });
});

test('demo workspace keeps its canvas inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/design/demo');
  await page.locator('.editor[data-hydrated]').waitFor();
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('face-view-canvas')).toBeVisible();
  const canvas = await page.getByTestId('face-view-canvas').boundingBox();
  expect(canvas!.y).toBeGreaterThanOrEqual(120);
  expect(canvas!.y + canvas!.height).toBeLessThanOrEqual(900);
  await expect(page.getByText('Demo · not saved')).toBeVisible();
  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('viewport-3d')).toBeVisible();
  const presets = await page.locator('.viewport-overlay').boundingBox();
  const lens = await page.locator('.viewport-lens').boundingBox();
  expect(presets!.y + presets!.height).toBeLessThan(lens!.y);
});
