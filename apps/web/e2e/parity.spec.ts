import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { encodeGray8Png, encodeRgbaPng } from '@pr/artwork/png';
import {
  compareRenders,
  grayToBytes,
  rgbaFromPng,
  type ParityReport,
  type RenderImage,
} from '@pr/parity';
import { uploadArtwork, waitForOrientationModel, waitForStored } from './helpers';
import type { StoredArtwork } from '../lib/editor-data';
import { STORAGE_STATE } from './global-setup';

/**
 * Preview-versus-render parity (I1, docs/20-testing-ci.md).
 *
 * The product's whole promise is that what the customer arranges in the browser is what comes out
 * of the path tracer. Every other test checks a part of that — the transform maths, the camera
 * helpers, the baked height map — and none of them checks the thing itself, because the thing
 * itself is two pictures agreeing.
 *
 * So this drives the real editor, takes the real preview, renders the same design through the real
 * queue, and measures the two against each other. It needs a worker, which is why it is skipped
 * without one; when it fails it attaches both images and a difference map, because a number alone
 * does not tell anyone what moved.
 */

test.describe.configure({ mode: 'default', timeout: 900_000 });
test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
test.skip(
  process.env['E2E_RENDER_WORKER'] !== 'true' && !process.env['CI'],
  'no render worker; set E2E_RENDER_WORKER=true',
);

test.use({ storageState: STORAGE_STATE });
test.beforeAll(() => {
  expect(process.env['E2E_RENDER_WORKER'], 'parity tests require the render worker').toBe('true');
});

/**
 * The camera the comparison is made from.
 *
 * Straight down at the decorated face. Every preset frames the product to the same share of the
 * frame, so a three-quarter view foreshortens the top into a band and a mark that moves across it
 * changes only a few hundred pixels — too few for any percentile to notice. Face-on, the mark is
 * large enough that where it sits is most of what the picture is.
 */
const CAMERA_PRESET = 'top';

/**
 * The mark's width, and how far it is moved for the control comparison.
 *
 * The cap's top zone is 30 mm square with a 1.5 mm margin, so a 14 mm mark can travel 6 mm and
 * still sit inside the safe area — the editor would refuse to place it outside, and a refused edit
 * would make the control compare a design against itself.
 */
const MARK_WIDTH_MM = 14;
const MOVED_BY_MM = 6;

test('the preview and the render agree, and disagree when the mark moves', async ({
  page,
}, testInfo) => {
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  // Printed in a pale ink rather than debossed. A relief mark on a dark green cap is a few per cent
  // of luminance in both renderers, so a measure could pass while placing it anywhere; ink makes
  // the mark the highest-contrast thing in frame, and therefore the thing the score is about.
  await page.getByTestId('finish-print').click();
  await page.getByTestId('ink-color').fill('#f2ede1');

  // An exact placement rather than wherever the upload landed: a parity failure should mean the two
  // renderers disagree, never that the test placed something slightly differently this time.
  await page.getByTestId('snap-toggle').uncheck();
  await page.getByTestId('input-width').fill(String(MARK_WIDTH_MM));
  await page.getByTestId('input-x').fill('0');
  await page.getByTestId('input-y').fill('0');
  await waitForStored(
    page,
    (s) =>
      s.document.placements[0]?.transform.sizeMm.w === MARK_WIDTH_MM &&
      s.document.placements[0]?.transform.offsetMm.x === 0,
    'the placement was never stored',
  );

  const preview = await capturePreview(page);
  await waitForStored(
    page,
    (s) => s.document.scene.camera.presetKey === CAMERA_PRESET,
    'the camera was never stored',
  );
  const render = await renderAtSize(page, preview.width, preview.height);

  // The control: the same render against a preview of a design that is genuinely different. Without
  // it the budget is unfalsifiable — a threshold nothing can fail is not a test.
  await page.getByTestId('mode-place').click();
  await page.getByTestId('input-x').fill(String(MOVED_BY_MM));
  await waitForStored(
    page,
    (s) => (s.document.placements[0]?.transform.offsetMm.x ?? 0) > MOVED_BY_MM / 2,
    'the mark was never moved',
  );
  const moved = await capturePreview(page);

  const matchedReport = compareRenders(preview, render);
  const movedReport = compareRenders(moved, render);

  await attach(testInfo, 'matched', preview, render, matchedReport);
  await attach(testInfo, 'moved', moved, render, movedReport);

  // The preview is a rasteriser and the render is a path tracer, so they will never be identical;
  // what has to survive is the placement — where the mark is, how big, which way round.
  expect(
    matchedReport.ok,
    `preview and render disagree: mean ${matchedReport.ssim.toFixed(3)} (floor ${matchedReport.budget.mean}), ` +
      `worst windows ${matchedReport.local.toFixed(3)} (floor ${matchedReport.budget.local}), ` +
      `worst window at ${matchedReport.worst.x},${matchedReport.worst.y}`,
  ).toBe(true);

  expect(
    movedReport.ok,
    `a mark moved ${MOVED_BY_MM} mm still passed the budget, so the budget is not measuring placement: ` +
      `mean ${movedReport.ssim.toFixed(3)}, worst windows ${movedReport.local.toFixed(3)}`,
  ).toBe(false);

  // And the two previews are not the same picture — otherwise the control above proves nothing
  // except that the editor ignored the move.
  expect(compareRenders(preview, moved).local).toBeLessThan(matchedReport.local);
});

/**
 * The same measurement for a mark that is cut rather than printed (`F-PREV-06`).
 *
 * The printed case above deliberately makes the mark the highest-contrast thing in frame, because
 * relief used to be "a few per cent of luminance in both renderers" — a mark shaded by tilting
 * normals has no silhouette and no occlusion, so face-on there is very little of it to measure.
 * That is no longer what the preview does: the zone carries a real displaced surface, and the
 * renderer has always subdivided and displaced at `standard` and above. The two are now doing the
 * same thing to the same geometry, so the relief itself is worth scoring.
 *
 * This is the case that would catch a regression in the shading split — geometry carrying the slope
 * it resolves and the fragment shader carrying only the residual. Get that wrong in either
 * direction and the relief is shaded at roughly half or twice the depth it should be, which is
 * invisible in a unit test and obvious here.
 */
test('a cut mark agrees with the render too', async ({ page }, testInfo) => {
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  await page.getByTestId('finish-emboss').click();
  await page.getByTestId('snap-toggle').uncheck();
  await page.getByTestId('input-width').fill(String(MARK_WIDTH_MM));
  await page.getByTestId('input-x').fill('0');
  await page.getByTestId('input-y').fill('0');
  await waitForStored(
    page,
    (s) =>
      s.document.placements[0]?.transform.sizeMm.w === MARK_WIDTH_MM &&
      s.document.placements[0]?.finish.kind === 'emboss',
    'the embossed placement was never stored',
  );

  // The preview must be drawing real geometry, or this is measuring the fallback and the budget
  // below is being met by the thing this test exists to replace.
  await page.getByTestId('mode-look').click();
  await expect
    .poll(async () => (await page.getByTestId('relief-readout').textContent())?.split(' ')[0], {
      timeout: 60_000,
    })
    .toBe('displaced');

  const preview = await capturePreview(page);
  await waitForStored(
    page,
    (s) => s.document.scene.camera.presetKey === CAMERA_PRESET,
    'the camera was never stored',
  );
  const render = await renderAtSize(page, preview.width, preview.height);

  const report = compareRenders(preview, render);
  await attach(testInfo, 'emboss', preview, render, report);

  expect(
    report.ok,
    `an embossed preview and its render disagree: mean ${report.ssim.toFixed(3)} ` +
      `(floor ${report.budget.mean}), worst windows ${report.local.toFixed(3)} ` +
      `(floor ${report.budget.local}), worst window at ${report.worst.x},${report.worst.y}`,
  ).toBe(true);
});

/**
 * The independent artwork finish must be resolved separately from the product's finish.
 * A Glossy body and Matte artwork exercise that distinction without restoring retired inks or foil.
 */
test('independent Matte artwork on a Glossy body agrees with the render', async ({ page }, testInfo) => {
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  await page.getByTestId('finish-emboss').click();
  await page.getByTestId('snap-toggle').uncheck();
  await page.getByTestId('input-width').fill(String(MARK_WIDTH_MM));
  await page.getByTestId('input-x').fill('0');
  await page.getByTestId('input-y').fill('0');

  await page.getByTestId('material-body').selectOption('pp-gloss');
  await page.getByTestId('ink-material').selectOption('pp-matte');

  await waitForStored(
    page,
    (s) =>
      s.document.placements[0]?.transform.sizeMm.w === MARK_WIDTH_MM &&
      s.document.placements[0]?.finish.kind === 'emboss' &&
      s.document.placements[0]?.finish.inkMaterialKey === 'pp-matte' &&
      s.document.materials['body']?.materialKey === 'pp-gloss',
    'the separately finished placement was never stored',
  );

  await page.getByTestId('mode-look').click();
  await expect
    .poll(async () => (await page.getByTestId('relief-readout').textContent())?.split(' ')[0], {
      timeout: 60_000,
    })
    .toBe('displaced');

  const preview = await capturePreview(page);
  await waitForStored(
    page,
    (s) => s.document.scene.camera.presetKey === CAMERA_PRESET,
    'the camera was never stored',
  );
  const render = await renderAtSize(page, preview.width, preview.height);

  const report = compareRenders(preview, render);
  await attach(testInfo, 'filled-relief', preview, render, report);

  expect(
    report.ok,
    `an independently finished Matte relief preview and its render disagree: mean ${report.ssim.toFixed(3)} ` +
      `(floor ${report.budget.mean}), worst windows ${report.local.toFixed(3)} ` +
      `(floor ${report.budget.local}), worst window at ${report.worst.x},${report.worst.y}`,
  ).toBe(true);
});

for (const [pack, product, variant, preset, width] of [
  ['cap-basic', 'cap', 'flat-38mm', 'top', 14],
  ['box-basic', 'carton-tuck', 'std', 'front', 40],
] as const) {
  test(`selected visible artwork preserves counters through preview and rendering on ${pack}`, async ({
    page,
  }, testInfo) => {
    page.setDefaultTimeout(30_000);
    await page.goto('/catalog');
    await page.getByTestId(`start-${pack}-${product}-${variant}`).click();
    await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
    const designId = new URL(page.url()).pathname.split('/').pop()!;
    let artworkId: string | null = null;
    try {
      const source = await readFile('fixtures/artwork/preparation/monogram.svg', 'utf8');
      await page.getByTestId('artwork-upload').setInputFiles({
        name: 'monogram.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(`<!-- ${randomUUID()} -->\n${source}`),
      });
      await page.getByTestId('keep-o1').check();
      await page.getByTestId('keep-o3').check();
      await expect(page.getByTestId('preparation-next')).toBeEnabled();
      await page.getByTestId('preparation-next').click();
      await page.getByTestId('preparation-name').fill(`Synthetic counters ${randomUUID()}`);
      await expect(page.getByTestId('preparation-save')).toBeEnabled();
      const response = page.waitForResponse(
        (r) => r.url().endsWith('/api/artworks/preparation') && r.request().method() === 'PUT',
      );
      await page.getByTestId('preparation-save').click();
      const saved = await response;
      expect(saved.ok(), await saved.text()).toBe(true);
      const artwork = (await saved.json()) as StoredArtwork;
      artworkId = artwork.ref.artworkId;
      await expect(page.getByTestId('artwork-preparation')).toHaveCount(0);
      await waitForStored(
        page,
        (s) => s.document.placements.length === 0,
        'preparation placed artwork automatically',
      );
      await page.getByTestId(`library-${artwork.ref.versionId}`).click();
      await waitForStored(
        page,
        (s) => s.document.placements[0]?.artwork.versionId === artwork.ref.versionId,
        'selected artwork was not placed',
      );
      await page.getByTestId('finish-print').click();
      await page.getByTestId('ink-color').fill('#f2ede1');
      await page.getByTestId('snap-toggle').uncheck();
      await page.getByTestId('input-width').fill(String(width));
      await page.getByTestId('input-x').fill('0');
      await page.getByTestId('input-y').fill('0');
      await waitForStored(
        page,
        (s) =>
          s.document.placements[0]?.transform.sizeMm.w === width &&
          s.document.placements[0]?.finish.tintHex === '#f2ede1',
        'prepared placement was not stored',
      );
      const preview = await capturePreview(page, preset);
      await waitForStored(
        page,
        (s) => s.document.scene.camera.presetKey === preset,
        'prepared camera was not stored',
      );
      const render = await renderAtSize(page, preview.width, preview.height);
      const report = compareRenders(preview, render);
      await attach(testInfo, `prepared-${pack}`, preview, render, report);
      expect(report.ok, `prepared ${pack} parity: mean ${report.ssim}, local ${report.local}`).toBe(
        true,
      );
    } finally {
      await page.evaluate(
        async ({ designId, artworkId }) => {
          await fetch(`/api/designs/${designId}`, { method: 'DELETE' });
          if (artworkId) await fetch(`/api/artworks/${artworkId}`, { method: 'DELETE' });
        },
        { designId, artworkId },
      );
    }
  });
}

test('confirmed orientation and Detail lighting agree through the real render queue', async ({
  page,
}, testInfo) => {
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  try {
    await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');
    await page.getByTestId('finish-print').click();
    await page.getByTestId('ink-color').fill('#f2ede1');
    await page.getByTestId('environment').selectOption('studio-detail-v1');
    await waitForStored(
      page,
      (s) => s.document.scene.environmentKey === 'studio-detail-v1',
      'Detail was not stored',
    );
    await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
    await page.getByTestId('reorient-product').click();
    await waitForOrientationModel(page);
    await page.getByTestId('orientation-view-top').click();
    await page.getByTestId('orientation-current-view').click();
    await page.getByTestId('orientation-confirm').click();
    await page.getByTestId('orientation-review').click();
    await page.getByTestId('orientation-finish').click();
    await expect(page.getByTestId('reorient-product')).toBeVisible();
    const preview = await capturePreview(page, 'front');
    await waitForStored(
      page,
      (s) =>
        s.document.scene.camera.presetKey === 'front' &&
        !!s.document.scene.presentationOrientationOverride,
      'oriented camera was not stored',
    );
    const render = await renderAtSize(page, preview.width, preview.height);
    const report = compareRenders(preview, render);
    await attach(testInfo, 'oriented-detail', preview, render, report);
    expect(report.ok, `oriented Detail parity: mean ${report.ssim}, local ${report.local}`).toBe(
      true,
    );
  } finally {
    await page.evaluate(async (designId) => {
      await fetch(`/api/designs/${designId}`, { method: 'DELETE' });
    }, id);
  }
});

/**
 * The preview as pixels, once it has settled.
 *
 * Settled means drawn, not mounted: the mesh arrives over the network and the zone texture is
 * composited after that, so a screenshot taken on `visible` catches an empty studio.
 */
async function capturePreview(page: Page, preset = CAMERA_PRESET): Promise<RenderImage> {
  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('viewport-3d')).toBeVisible();
  await expect(page.getByTestId('viewport-loading')).toHaveCount(0, { timeout: 60_000 });
  await page.getByTestId(`camera-${preset}`).click();

  await expect
    .poll(() => distinctColours(page), {
      timeout: 60_000,
      message: 'the preview never drew the product',
    })
    .toBeGreaterThan(20);

  // The environment's image-based lighting is built after the first frame; without a beat here the
  // capture is of a product lit by nothing, which is a difference the renderer does not share.
  await page.waitForTimeout(2_000);

  // The canvas' own drawing buffer, not a screenshot of the page: the camera-preset buttons sit on
  // top of the viewport, and an element screenshot would include them as a difference the renderer
  // could never match. `preserveDrawingBuffer` is on for exactly this kind of read.
  const encoded = await page
    .getByTestId('viewport-3d')
    .locator('canvas')
    .evaluate((element) => (element as HTMLCanvasElement).toDataURL('image/png'));

  return rgbaFromPng(Buffer.from(encoded.slice(encoded.indexOf(',') + 1), 'base64'));
}

function distinctColours(page: Page): Promise<number> {
  return page.evaluate(() => {
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
  });
}

/**
 * The exact drawing-buffer size avoids aspect rounding shifting silhouettes by half a pixel.
 * Those edge windows otherwise dominate a comparison that is supposed to measure the artwork.
 */
async function renderAtSize(page: Page, widthPx: number, heightPx: number): Promise<RenderImage> {

  await page.getByTestId('preset-draft').click();
  await page.getByTestId('size-custom').click();
  await page.getByTestId('size-width').fill(String(widthPx));
  await page.getByTestId('size-height').fill(String(heightPx));
  await page.getByTestId('format-png8').click();
  await page.getByTestId('render-button').click();

  await expect(page.getByTestId('render-job')).toHaveAttribute('data-status', 'succeeded', {
    timeout: 600_000,
  });

  const href = await page.getByTestId('render-output').first().getAttribute('href');

  // Fetched from inside the page rather than through Playwright's API context: the download is
  // authorised by the session cookie, and this is also the path a customer's browser takes.
  const encoded = await page.evaluate(async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`downloading the render returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }, href!);

  return rgbaFromPng(Buffer.from(encoded, 'base64'));
}

/**
 * Both pictures and the difference between them, in the report.
 *
 * A parity failure is a visual fact; "0.42" is not something anyone can act on, and the difference
 * map points straight at whichever edge moved.
 */
async function attach(
  testInfo: TestInfo,
  label: string,
  preview: RenderImage,
  render: RenderImage,
  report: ParityReport,
): Promise<void> {
  const write = async (name: string, body: Buffer, contentType: string) => {
    // Written to a file and attached by path rather than by body: the files survive the run, which
    // is what anyone debugging a parity failure on their own machine actually wants.
    const path = testInfo.outputPath(`${label}-${name}`);
    await writeFile(path, body);
    await testInfo.attach(`${label}-${name}`, { path, contentType });
  };

  await write('preview.png', asPng(preview), 'image/png');
  await write('render.png', asPng(render), 'image/png');
  await write(
    'difference.png',
    encodeGray8Png(
      grayToBytes(report.difference),
      report.difference.width,
      report.difference.height,
    ),
    'image/png',
  );
  await write(
    'report.json',
    Buffer.from(
      JSON.stringify(
        {
          mean: report.ssim,
          localWorstWindows: report.local,
          worst: report.worst,
          meanAbsolute: report.meanAbsolute,
          comparedAt: { width: report.width, height: report.height },
          budget: report.budget,
          ok: report.ok,
        },
        null,
        2,
      ),
    ),
    'application/json',
  );
}

/** RGBA back to a PNG, so the attachment is something a browser will show. */
function asPng(image: RenderImage): Buffer {
  return encodeRgbaPng(image.rgba, image.width, image.height);
}
