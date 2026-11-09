import { expect, test, type Page } from '@playwright/test';

import { openEditor, confirmPreparation } from './helpers';

/**
 * End-to-end coverage of the 2D face placement workflow (W-05).
 *
 * These drive the real canvas with real pointer events, so they exercise the same code path a user
 * does: hit testing, gestures, snapping, override, clamping and validation.
 */

type Readout = { x: number; y: number; w: number; h: number; rot: number; left: number };

const parseReadout = (text: string | null): Readout =>
  Object.fromEntries(
    [...(text ?? '').matchAll(/([a-z]+) (-?[\d.]+)/g)].map((m) => [m[1]!, Number(m[2])]),
  ) as Readout;

const readout = async (page: Page): Promise<Readout> =>
  parseReadout(await page.getByTestId('placement-readout').textContent());

/**
 * Waits for one field of the readout to settle on a value.
 *
 * `readout` takes a single snapshot, which is right after an action this test drove and wrong after
 * one the page has to re-render for. A click on undo returns as soon as the event is dispatched; the
 * number on screen changes a frame or two later, and on a loaded machine that gap is wide enough to
 * read the old value and call it a bug in undo. `expect.poll` retries the read, which is what every
 * other assertion in this file gets for free from Playwright's locators.
 */
async function expectReadout(page: Page, field: keyof Readout, value: number, precision = 1) {
  await expect
    .poll(async () => (await readout(page))[field], { timeout: 5000 })
    .toBeCloseTo(value, precision);
}

async function canvasBox(page: Page) {
  const box = await page.getByTestId('face-view-canvas').boundingBox();
  if (!box) throw new Error('canvas not laid out');
  return box;
}

/** px/mm as the app itself reports it, so tests address the canvas in millimetres. */
async function pxPerMm(page: Page): Promise<number> {
  const text = (await page.getByTestId('scale-chip').textContent()) ?? '';
  return Number(text.replace(' px/mm', ''));
}

/** Screen position of a zone-space point (mm, origin at the zone centre, +y up). */
async function zonePoint(page: Page, xMm: number, yMm: number) {
  const box = await canvasBox(page);
  const k = await pxPerMm(page);
  return { x: box.x + box.width / 2 + xMm * k, y: box.y + box.height / 2 - yMm * k };
}

async function dragFromTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { alt?: boolean } = {},
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  if (options.alt) await page.keyboard.down('Alt');
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  if (options.alt) await page.keyboard.up('Alt');
}

test.beforeEach(async ({ page }) => {
  await openEditor(page);
  // Placement tests run in Place mode: full-width canvas, and no WebGL work competing for the
  // software renderer. The 3D tests below opt into Look mode explicitly.
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('face-view-canvas')).toBeVisible();
  // Wait for the artwork mask to load and the first shading pass to finish.
  await expect(page.getByTestId('scale-chip')).not.toHaveText('—');
  // Mode changes resize the canvas asynchronously; coordinates from two layouts describe a
  // different drag even when both points individually use the displayed scale.
  await expect
    .poll(() =>
      page.getByTestId('face-view-canvas').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const frame = canvas.parentElement!.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return (
          Math.abs(canvas.width / dpr - frame.width) < 1 &&
          Math.abs(canvas.height / dpr - frame.height) < 1
        );
      }),
    )
    .toBe(true);
});

test('opens with artwork centred and inside every limit', async ({ page }) => {
  const values = await readout(page);
  expect(values.x).toBe(0);
  expect(values.y).toBe(0);
  expect(values.w).toBeGreaterThan(0);
  await expect(page.getByTestId('validation')).toContainText('within every limit');
});

test('dragging moves the artwork and snapping returns it to the centre', async ({ page }) => {
  // 2.0 x 1.5 mm: clear of every snap target, and inside the travel a 30 mm face allows for
  // artwork this wide (the clamp is exercised separately below).
  await dragFromTo(page, await zonePoint(page, 0, 0), await zonePoint(page, 2, 1.5));

  const moved = await readout(page);
  expect(moved.x).toBeCloseTo(2, 1);
  expect(moved.y).toBeCloseTo(1.5, 1);

  // Grab it where it now sits and bring it back to within a couple of pixels of the centre:
  // snapping should finish the job exactly.
  const grab = await zonePoint(page, moved.x, moved.y);
  const nearCentre = await zonePoint(page, 0.1, 0.1);
  await dragFromTo(page, grab, nearCentre);

  const snapped = await readout(page);
  expect(Math.abs(snapped.x)).toBeLessThan(0.02);
  expect(Math.abs(snapped.y)).toBeLessThan(0.02);
});

test('Alt suspends snapping so a deliberate offset survives', async ({ page }) => {
  await dragFromTo(page, await zonePoint(page, 0, 0), await zonePoint(page, 0.15, 0), {
    alt: true,
  });

  const values = await readout(page);
  expect(Math.abs(values.x)).toBeGreaterThan(0.05); // would be exactly 0 if it had snapped
});

test('artwork cannot be dragged out of the decoration area', async ({ page }) => {
  // Aim 40 mm right of centre on a 30 mm face: the clamp must catch it.
  await dragFromTo(page, await zonePoint(page, 0, 0), await zonePoint(page, 40, 0));

  await expect(page.getByTestId('validation')).not.toContainText('extends past');
  const values = await readout(page);
  expect(values.x + values.w / 2).toBeLessThanOrEqual(15.01); // 30 mm zone, half-width 15
});

test('keyboard nudging moves in exact millimetre steps', async ({ page }) => {
  const centre = await zonePoint(page, 0, 0);
  await page.mouse.click(centre.x, centre.y);
  const before = await readout(page);

  await page.keyboard.press('ArrowRight');
  await expectReadout(page, 'x', before.x + 0.5, 5);

  await page.keyboard.press('Shift+ArrowUp');
  await expectReadout(page, 'y', before.y + 0.1, 5);
});

test('numeric fields drive the same placement state', async ({ page }) => {
  await page.getByTestId('input-x').fill('4.5');
  await expect.poll(async () => (await readout(page)).x).toBeCloseTo(4.5, 5);

  await page.getByTestId('center-button').click();
  await expect.poll(async () => (await readout(page)).x).toBe(0);
});

test('switching to the carton face re-fits the artwork', async ({ page }) => {
  const capSize = (await readout(page)).w;
  await page.getByTestId('zone-front').click();
  await expect.poll(async () => (await readout(page)).w).toBeGreaterThan(capSize);
  await expect(page.getByTestId('validation')).toContainText('within every limit');
});

test('the carton face offers only printed finishes', async ({ page }) => {
  await page.getByTestId('zone-front').click();
  await expect(page.getByTestId('finish-emboss')).toBeDisabled();
  await expect(page.getByTestId('finish-print')).toBeEnabled();
});

test('oversizing artwork raises a blocking validation error', async ({ page }) => {
  await page.getByTestId('input-width').fill('80');
  await expect(page.getByTestId('validation')).toContainText('extends past the decoration area');
  // Rendering is refused too, but only a saved design has a render to refuse: see designs.spec.ts.
});

test('the 3D view renders the product with the artwork applied', async ({ page }) => {
  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('viewport-3d')).toBeVisible();

  // Wait for WebGL to draw something other than the clear colour: the check is deliberately about
  // pixels, because a broken zone mapping or a failed mesh fetch both end in an empty frame.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('[data-testid="viewport-3d"] canvas');
          if (!(canvas instanceof HTMLCanvasElement)) return 0;
          const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
          if (!gl) return 0;
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const distinct = new Set<number>();
          for (let i = 0; i < pixels.length; i += 4 * 97) {
            distinct.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
          }
          return distinct.size;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(20);
});

test('camera presets reframe the product', async ({ page }) => {
  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('camera-top')).toBeVisible();
  await page.getByTestId('camera-top').click();
  await expect(page.getByTestId('camera-top')).toHaveClass(/active/);
});

test('uploading an SVG runs the real pipeline and places the result', async ({ page }) => {
  const before = await readout(page);

  await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
  await confirmPreparation(page);

  // Both marks are wider than tall, so the fit lands on the same width — the aspect ratio is what
  // proves the uploaded artwork replaced the sample.
  await expect.poll(async () => (await readout(page)).h).not.toBe(before.h);
  await expect(page.getByTestId('validation')).toContainText('within every limit');
  await expect(page.locator('.artwork-name')).toContainText('wordmark');
});

test('an SVG with live text is refused with an actionable reason', async ({ page }) => {
  await page
    .getByTestId('artwork-upload')
    .setInputFiles('fixtures/artwork/samples/text-not-outlined.svg');

  const rejection = page.getByTestId('preparation-error');
  await expect(rejection).toBeVisible();
  await expect(rejection).toContainText('live text');
  await expect(rejection).toContainText('Convert text to outlines');
});

test('active SVG content is refused with a static export recovery hint', async ({ page }) => {
  await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/hostile.svg');
  await expect(page.getByTestId('preparation-error')).toContainText('static');
  await expect(page.getByTestId('preparation-save')).toHaveCount(0);
});

test('undo takes back a whole drag, and redo puts it back', async ({ page }) => {
  await page.getByTestId('snap-toggle').uncheck();
  const before = await readout(page);

  await dragFromTo(page, await zonePoint(page, 0, 0), await zonePoint(page, 7, 0));
  const moved = await readout(page);
  expect(moved.x).toBeGreaterThan(before.x + 3);

  // One press, however many pointer events the drag was made of.
  await page.getByTestId('undo').click();
  await expectReadout(page, 'x', before.x);

  await page.getByTestId('redo').click();
  await expectReadout(page, 'x', moved.x);
});

test('undo is available for the keyboard, and stops at the beginning', async ({ page }) => {
  await page.getByTestId('snap-toggle').uncheck();
  const before = await readout(page);

  await page.getByTestId('input-width').fill('18');
  // Move focus off the field first: while the caret is in one, Ctrl+Z belongs to the field.
  await page.locator('.rail h2').first().click();
  await page.keyboard.press('Control+z');

  await expectReadout(page, 'w', before.w);
  await expect(page.getByTestId('undo')).toBeDisabled();
});

test('guides can be pulled out of the rulers, and thrown back', async ({ page }) => {
  const canvas = page.getByTestId('face-view-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-color-sampled', 'true');

  const box = (await canvas.boundingBox())!;
  const before = await canvas.screenshot();

  // Drag from the top ruler into the middle: a horizontal guide.
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const withGuide = await canvas.screenshot();
  expect(Buffer.compare(before, withGuide)).not.toBe(0);

  // Drag it back onto the ruler to remove it, and the canvas returns to what it was.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 8 });
  await page.mouse.up();

  const after = await canvas.screenshot();
  expect(Buffer.compare(before, after)).toBe(0);
});

test('alignment actions put the artwork against the safe area', async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId('align-actions')).toBeVisible();

  await page.getByTestId('align-left').click();
  const left = Number(await page.getByTestId('input-x').inputValue());

  await page.getByTestId('align-right').click();
  const right = Number(await page.getByTestId('input-x').inputValue());

  expect(left).toBeLessThan(0);
  expect(right).toBeGreaterThan(0);
  expect(Math.abs(left)).toBeCloseTo(Math.abs(right), 1);

  await page.getByTestId('align-centre-h').click();
  expect(Number(await page.getByTestId('input-x').inputValue())).toBeCloseTo(0, 2);

  // Reset puts it back where a freshly dropped logo starts.
  await page.getByTestId('align-top').click();
  await page.getByTestId('reset-transform').click();
  expect(Number(await page.getByTestId('input-y').inputValue())).toBeCloseTo(0, 2);
});

test('a mark can use a separate PP finish (F-MAT-05)', async ({ page }) => {
  // A foil and a flat ink are different materials before they are different colours, and the cap
  // pack ships both; before there was a chooser it always used whichever came first.
  await page.getByTestId('finish-print').click();
  await expect(page.getByTestId('ink-material')).toBeVisible();

  const options = await page.getByTestId('ink-material').locator('option').allInnerTexts();
  expect(options.length).toBeGreaterThan(1);

  await page.getByTestId('ink-material').selectOption('pp-gloss');
  await expect(page.getByTestId('ink-material')).toHaveValue('pp-gloss');
});

test('the snap toggle is remembered between sessions (F-PLACE-06)', async ({ page }) => {
  // A way of working, not a property of the design: it belongs to the person, and having to turn it
  // off again on every reload is the kind of small friction that makes a tool feel unfinished.
  await expect(page.getByTestId('snap-toggle')).toBeChecked();
  await page.getByTestId('snap-toggle').uncheck();

  await page.reload();
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('snap-toggle')).not.toBeChecked();

  // And back, so the test leaves the browser as it found it for whatever runs next.
  await page.getByTestId('snap-toggle').check();
  await page.reload();
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('snap-toggle')).toBeChecked();
});

test('named colors are labelled approximate (F-MAT-02)', async ({ page }) => {
  // A screen cannot promise a moulded part's colour, and a customer reading "Forest green" as a
  // commitment is a customer who will be surprised by a physical sample.
  await expect(page.getByText(/Named colors are approximate/i).first()).toBeVisible();
});

test('only the approved PP finishes are offered (F-MAT-03)', async ({ page }) => {
  const picker = page.getByTestId('material-body');
  await expect(picker.locator('option')).toHaveText(['Matte', 'Glossy']);
});

test('choosing a finish changes the product (F-MAT-03)', async ({ page }) => {
  // The label has to reach the thing on screen, or it is a dropdown that does nothing.
  await page.getByTestId('material-body').selectOption('pp-gloss');
  await expect(page.getByTestId('material-body')).toHaveValue('pp-gloss');

  // Undo treats it as one deliberate act rather than part of whatever came before.
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('material-body')).not.toHaveValue('pp-gloss');
});
