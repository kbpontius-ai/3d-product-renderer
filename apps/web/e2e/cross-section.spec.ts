import { rgbaFromPng } from '@pr/parity';
import { expect, test, type Locator } from '@playwright/test';
import { openEditor } from './helpers';

test.use({ viewport: { width: 1600, height: 1000 } });

async function drawnPixels(canvas: Locator) {
  const url = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL('image/png'));
  return rgbaFromPng(Buffer.from(url.split(',')[1]!, 'base64'));
}

test('section follows relief edits without remounting the viewport', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /shader|glsl|webgl/i.test(message.text())) errors.push(message.text());
  });
  await openEditor(page);
  await page.getByTestId('mode-split').click();
  await page.getByTestId('finish-deboss').click();
  await page.getByTestId('depth-slider').fill('0.6');
  await page.getByTestId('section-artwork').click();
  await page.getByTestId('section-offset').fill('-2.5');
  await expect(page.getByTestId('relief-readout')).toContainText('displaced');
  await page.getByRole('button', { name: 'Logo close-up', exact: true }).click();
  await page.getByTestId('lens-focal').fill('200');
  const canvas = page.getByTestId('viewport-3d').locator('canvas');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 240, bounds.y + bounds.height / 2, { steps: 20 });
  await page.mouse.up();
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: testInfo.outputPath('deboss.png') });
  const deboss = await drawnPixels(canvas);
  expect(errors).toEqual([]);
  await page.getByTestId('finish-emboss').click();
  await expect.poll(async () => {
    const emboss = await drawnPixels(canvas);
    let changed = 0;
    for (let i = 0; i < deboss.rgba.length; i += 4) {
      if (Math.abs(deboss.rgba[i]! - emboss.rgba[i]!) > 8) changed++;
    }
    return changed;
  }).toBeGreaterThan(25);
  await page.screenshot({ path: testInfo.outputPath('emboss.png') });
  await page.getByTestId('snap-toggle').uncheck();
  await page.getByTestId('input-x').fill('3');
  await page.getByTestId('section-offset').fill('0');
  await page.getByTestId('section-off').click();
  await page.getByTestId('section-artwork').click();
  expect(errors).toEqual([]);
});


test('a cut through a deboss leaves the removed material empty', async ({ page }, testInfo) => {
  await openEditor(page);
  await page.getByTestId('mode-look').click();
  await page.getByTestId('background-solid').click();
  await page.getByTestId('background-color').fill('#ff00ff');
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.getByTestId('section-bbox-y').click();
  // The top is y=18. A cut at y=17.5 passes above a 0.6 mm pocket's floor.
  await page.getByTestId('section-offset').fill('8.5');
  await page.getByTestId('finish-print').click();
  const canvas = page.getByTestId('viewport-3d').locator('canvas');
  const pixels = () => drawnPixels(canvas);
  await expect(page.getByTestId('relief-readout')).toContainText('displaced');
  await page.waitForTimeout(2000);
  const whole = await pixels();
  const missing = async () => {
    const cut = await pixels();
    let count = 0;
    const isBackground = (rgba: Uint8Array, i: number) =>
      rgba[i]! > 220 && rgba[i + 1]! < 50 && rgba[i + 2]! > 220;
    for (let i = 0; i < whole.rgba.length; i += 4) {
      if (!isBackground(whole.rgba, i) && isBackground(cut.rgba, i)) count++;
    }
    return count;
  };
  await page.getByTestId('finish-deboss').click();
  await page.getByTestId('depth-slider').fill('0.6');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: testInfo.outputPath('pocket-section.png') });
  await expect.poll(missing).toBeGreaterThan(50);
  await page.getByTestId('depth-slider').fill('0.1');
  await expect.poll(missing).toBeLessThan(10);
  await page.getByTestId('finish-emboss').click();
  await page.getByTestId('depth-slider').fill('0.6');
  await expect.poll(missing).toBeLessThan(10);
});
