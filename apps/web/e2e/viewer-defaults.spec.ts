import { expect, test } from '@playwright/test';

test('opens in Viewer with Inspection at zero and keeps all three modes usable', async ({
  page,
}, testInfo) => {
  await page.goto('/design/demo');
  await expect(page.getByTestId('mode-look')).toHaveText('Viewer');
  await expect(page.getByTestId('mode-look')).toHaveClass('active');
  await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('inspection-rotation')).toHaveValue('0');
  const buttons = ['mode-place', 'mode-split', 'mode-look'];
  const bounds = await Promise.all(buttons.map((id) => page.getByTestId(id).boundingBox()));
  for (let i = 1; i < bounds.length; i++) {
    expect(bounds[i]!.x - (bounds[i - 1]!.x + bounds[i - 1]!.width)).toBeGreaterThanOrEqual(7);
  }
  await expect(page.locator('[data-testid="viewport-3d"] canvas')).toBeVisible();
  await expect(page.getByTestId('viewport-loading')).toBeHidden();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: testInfo.outputPath('viewer-default.png') });
  for (const id of buttons) {
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveClass('active');
    if (id !== 'mode-look')
      await expect(page.getByTestId('face-view-canvas')).toBeVisible();
    if (id !== 'mode-place')
      await expect(page.getByTestId('viewport-3d')).toBeVisible();
  }
  await page.getByTestId('inspection-rotation').fill('75');
  await page.getByTestId('design-lighting').click();
  await expect(page.getByTestId('design-lighting')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByTestId('mode-look')).toHaveClass('active');
  await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('inspection-rotation')).toHaveValue('0');
});
