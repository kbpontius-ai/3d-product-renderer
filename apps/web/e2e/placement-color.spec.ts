import { expect, test } from '@playwright/test';
import { openEditor } from './helpers';

test('samples Viewer lighting for placement, updates it in Place mode and preserves the assignment', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openEditor(page);
  await page.getByTestId('mode-split').click();
  const face = page.getByTestId('face-view-canvas');
  const color = () => face.getAttribute('data-surface-color');
  await expect(face).toHaveAttribute('data-color-sampled', 'true');
  await expect(page.getByTestId('placement-loading')).toBeHidden();
  await expect(face).toBeVisible();
  await expect.poll(color).toMatch(/^#[0-9a-f]{6}$/);
  await expect.poll(color).not.toBe('#1b4d3e');
  await expect.poll(color).not.toBe('#000000');
  const inspection = await color();
  await page.getByTestId('design-lighting').click();
  await expect.poll(color).not.toBe(inspection);
  const studio = await color();
  await page.getByTestId('mode-place').click();
  await expect.poll(color).toBe(studio);
  await page.getByTestId('inspect-artwork').click();
  await expect.poll(color).toBe(inspection);
  await page.getByTestId('inspection-rotation').fill('90');
  await expect.poll(color).not.toBe(inspection);
  await page.getByTestId('inspection-reset').click();
  await expect.poll(color).toBe(inspection);
  await page.getByTestId('hex-body').fill('#f9a615');
  await expect(face).toHaveAttribute('data-color-sampled', 'true');
  await expect.poll(color).not.toBe(inspection);
  await expect.poll(color).not.toBe('#000000');
  await expect(page.getByTestId('hex-body')).toHaveValue('#f9a615');
  const matte = await color();
  await page.getByTestId('material-body').selectOption('pp-gloss');
  await expect(face).toHaveAttribute('data-color-sampled', 'true');
  await expect.poll(color).not.toBe(matte);
  await page.getByTestId('mode-split').click();
  await expect(page.getByTestId('viewport-loading')).toBeHidden();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('placement-color-split.png') });
  expect(errors).toEqual([]);
});

test('placement does not wait for the color sample', async ({ page }) => {
  // The sampler skips every frame while its context reports lost, so this is a sample that never
  // arrives — the slow-renderer case taken to its limit. Only the 16×16 swatch is affected.
  await page.addInitScript(() => {
    const isContextLost = WebGL2RenderingContext.prototype.isContextLost;
    WebGL2RenderingContext.prototype.isContextLost = function () {
      return this.canvas.width === 16 || isContextLost.call(this);
    };
  });
  await openEditor(page);
  await page.getByTestId('mode-place').click();
  const face = page.getByTestId('face-view-canvas');
  await expect(face).toBeVisible();
  await expect(page.getByTestId('placement-loading')).toBeHidden();
  await expect(face).toHaveAttribute('data-color-sampled', 'false');
});
