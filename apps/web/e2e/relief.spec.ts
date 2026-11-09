import { expect, test, type Page } from '@playwright/test';
import { rgbaFromPng } from '@pr/parity';

import { openEditor, confirmPreparation } from './helpers';

/**
 * The decorated zone is drawn as real geometry, not as shading (`F-PREV-06`).
 *
 * These run against a real WebGL context in a real browser, which is the only place two of the
 * three risks in this feature actually live. The shaders are built by string surgery on three.js'
 * chunks and can only be proven to compile by compiling them; and the fallback from displaced
 * geometry to shading is silent by design, so nothing short of asking the page tells you which one
 * you are looking at.
 */

/** Console output three.js produces when a shader fails to compile or link. */
const SHADER_TROUBLE = /shader|glsl|program|webgl/i;

async function watchForShaderErrors(page: Page): Promise<() => string[]> {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (SHADER_TROUBLE.test(message.text())) problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  return () => problems;
}

type Relief =
  | { kind: 'shaded' }
  | {
      kind: 'displaced';
      triangles: number;
      segmentsX: number;
      segmentsY: number;
      spacingMm: number;
      fallbackVertices: number;
      bodyVertices: number;
    };

function parseRelief(text: string | null): Relief {
  const raw = (text ?? '').trim();
  if (raw !== 'displaced'.slice(0, 0) && raw.startsWith('displaced')) {
    const read = (key: string): number =>
      Number(new RegExp(`${key} (-?[\\d.]+)`).exec(raw)?.[1] ?? NaN);
    const grid = /grid (\d+)x(\d+)/.exec(raw);
    return {
      kind: 'displaced',
      triangles: read('tris'),
      segmentsX: Number(grid?.[1] ?? NaN),
      segmentsY: Number(grid?.[2] ?? NaN),
      spacingMm: read('spacing'),
      fallbackVertices: read('fallback'),
      bodyVertices: read('body'),
    };
  }
  return { kind: 'shaded' };
}

async function relief(page: Page): Promise<Relief> {
  return parseRelief(await page.getByTestId('relief-readout').textContent());
}

/**
 * The canvas' own drawing buffer, as `parity.spec.ts` reads it.
 *
 * An element screenshot can hand back the page compositor's copy, which under `frameloop="demand"`
 * may be a frame nobody has repainted. `preserveDrawingBuffer` is on for exactly this read.
 */
async function drawnPixels(page: Page): Promise<Buffer> {
  const encoded = await page
    .getByTestId('viewport-3d')
    .locator('canvas')
    .evaluate((element) => (element as HTMLCanvasElement).toDataURL('image/png'));
  return Buffer.from(encoded.slice(encoded.indexOf(',') + 1), 'base64');
}

/**
 * How many pixels moved by more than a just-noticeable amount.
 *
 * Counting pixels rather than comparing buffers, and counting rather than averaging. `Buffer`
 * inequality is satisfied by one pixel of antialiasing noise, which is how a test can pass while
 * the viewport is not responding at all; and a mean over the whole frame is swamped by the
 * background, because a 14 mm mark on a 38 mm cap is well under a percent of the pixels.
 */
function movedPixels(before: Buffer, after: Buffer): number {
  const a = rgbaFromPng(before);
  const b = rgbaFromPng(after);
  if (a.width !== b.width || a.height !== b.height) return -1;

  let moved = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    const luminance = (rgba: Uint8Array) => (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / 3;
    if (Math.abs(luminance(a.rgba) - luminance(b.rgba)) > 4) moved++;
  }
  return moved;
}

/**
 * Asserts the viewport actually responded to something, against its own measured noise.
 *
 * A fixed pixel threshold is wrong twice over: too low and antialiasing jitter passes it, too high
 * and it fails on a narrower pane where the mark covers fewer pixels — which is exactly what a
 * split-view layout does. So the floor is measured here, from two frames with nothing happening
 * between them, and the real change has to clear it by a wide margin.
 */
async function expectViewportResponds(
  page: Page,
  act: () => Promise<void>,
  what: string,
): Promise<Buffer> {
  const first = await drawnPixels(page);
  await page.waitForTimeout(1200);
  const settled = await drawnPixels(page);
  const noise = movedPixels(first, settled);

  const floor = Math.max(25, noise * 4 + 25);
  await act();
  await expect
    .poll(async () => movedPixels(settled, await drawnPixels(page)), {
      timeout: 20_000,
      message: `${what} did not change the 3D view (noise floor ${noise} px)`,
    })
    .toBeGreaterThan(floor);

  return drawnPixels(page);
}

/** Opens the demo design in the 3D view with a piece of artwork placed and an emboss selected. */
async function openLookMode(page: Page, finish: 'emboss' | 'deboss' = 'emboss') {
  await openEditor(page);
  await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
  await confirmPreparation(page);
  await expect(page.getByTestId('artwork-name')).toBeVisible();
  await page.getByTestId(`finish-${finish}`).click();
  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('viewport-3d')).toBeVisible();
}

test.describe('displaced relief geometry', () => {
  test('draws the zone as a subdivided surface, not as shading', async ({ page }) => {
    const problems = await watchForShaderErrors(page);
    await openLookMode(page);

    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');

    const state = await relief(page);
    if (state.kind !== 'displaced') throw new Error('expected a displaced relief');

    // A real grid: enough triangles to carry a sub-millimetre feature, inside the ceiling.
    expect(state.triangles).toBeGreaterThan(10_000);
    expect(state.segmentsX).toBeLessThanOrEqual(1024);
    expect(state.segmentsY).toBeLessThanOrEqual(1024);
    // Sub-millimetre vertex spacing is the whole point; above that a 0.3 mm emboss has nowhere to go.
    expect(state.spacingMm).toBeLessThan(0.5);
    // The cap's zones are analytic, so nothing should have needed to fall back to the frame.
    expect(state.fallbackVertices).toBe(0);

    expect(problems(), 'shaders must compile').toEqual([]);
  });

  test('compiles both roles — the product and the patch over its zone', async ({ page }) => {
    // Two materials mean two programs. A failure in either is a console error and, for the patch,
    // a preview that looks exactly like the one this replaced.
    const problems = await watchForShaderErrors(page);
    await openLookMode(page);
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');

    // Give the second program a frame to compile: the patch is drawn after the product.
    await page.waitForTimeout(1500);
    expect(problems()).toEqual([]);
  });

  test('keeps the relief when the finish flips to deboss', async ({ page }) => {
    // Deboss is the case that forced the product mesh to punch a hole: the pocket dips below the
    // original surface and the coarse mesh would otherwise occlude it entirely.
    const problems = await watchForShaderErrors(page);
    await openLookMode(page, 'deboss');
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    expect(problems()).toEqual([]);
  });

  test('survives switching zones, including the cylindrical one', async ({ page }) => {
    const problems = await watchForShaderErrors(page);
    await openLookMode(page);
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    const flat = await relief(page);

    await page.getByTestId('mode-place').click();
    await page.getByTestId('zone-skirt').click();
    await page.getByTestId('mode-look').click();

    // The skirt is a different shape — 40 x 10 mm rather than 30 x 30 — so the grid must be too.
    await expect
      .poll(
        async () => {
          const state = await relief(page);
          return state.kind === 'displaced' ? state.segmentsX : -1;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    const curved = await relief(page);
    if (flat.kind !== 'displaced' || curved.kind !== 'displaced')
      throw new Error('expected both displaced');
    expect(curved.segmentsX / curved.segmentsY).toBeGreaterThan(flat.segmentsX / flat.segmentsY);
    expect(curved.fallbackVertices).toBe(0);
    // Planar and cylindrical zones are mapped exactly by the shader and carry nothing.
    expect(flat.bodyVertices).toBe(0);
    expect(curved.bodyVertices).toBe(0);

    expect(problems()).toEqual([]);
  });

  test('walks a surface that cannot be unrolled — the oval bottle flank', async ({ page }) => {
    /*
     * The one zone in the repository whose grid is built by walking the surface rather than
     * projecting onto it (`F-ZONE-04`, `buildSurfaceGrid`).
     *
     * Every other zone here is developable — the cap's flat top and its cylindrical skirt, the
     * carton's planes — and on those a projection and a walk agree, so none of them can tell the
     * two apart. The bottle's flank curves in two directions at once, and it is the only place in
     * this suite where getting the mapping wrong shows up rather than cancelling out.
     *
     * Concretely, this is the case that crashed. `patchResolution` hands back odd segment counts
     * for this zone (176 x 137), the grid assumed even ones, and the NaN it wrote surfaced as
     * "cannot normalize a zero-length vector" — a page error, from a zone nothing in CI opened.
     * The unit tests cover the walk's arithmetic; only a browser covers the walk reaching a screen.
     */
    const problems = await watchForShaderErrors(page);
    await openEditor(page);
    await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
    await confirmPreparation(page);
    await expect(page.getByTestId('artwork-name')).toBeVisible();

    await page.getByTestId('zone-flank').click();
    await page.getByTestId('finish-deboss').click();
    await page.getByTestId('mode-look').click();
    await expect(page.getByTestId('viewport-3d')).toBeVisible();

    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    const state = await relief(page);
    if (state.kind !== 'displaced') throw new Error('expected a displaced relief');

    expect(state.triangles).toBeGreaterThan(10_000);
    expect(state.spacingMm).toBeLessThan(0.5);

    /*
     * The assertion that matters. Every node walked to a real surface point: none gave up and fell
     * back to the frame, and none produced a NaN. On a doubly-curved zone that is the difference
     * between millimetres that mean something and a patch floating over the part.
     */
    expect(state.fallbackVertices).toBe(0);
    expect(Number.isFinite(state.segmentsX)).toBe(true);
    expect(Number.isFinite(state.segmentsY)).toBe(true);

    /*
     * And the bottle itself knows where the zone is on it. The walk has no inverse a shader could
     * evaluate, so the bottle's vertices carry the patch's coordinates (zone kind 3). Without them
     * the bottle treats the zone as flat, stops counting itself inside it once the flank has curved
     * a projection depth away from the frame, and draws straight over the pockets of a deboss.
     */
    expect(state.bodyVertices).toBeGreaterThan(0);

    expect(problems(), 'no shader or page errors on a doubly-curved zone').toEqual([]);
  });

  test('deepens the relief when the depth control is turned up', async ({ page }) => {
    /*
     * The height layer is 8-bit, so its encode range is its step size, and the range now follows
     * the design's own depth rather than sitting at the schema maximum — which means the encoder
     * and the shader have to agree about it on every change. If they drift, nothing errors: the
     * relief is simply rendered at the wrong depth, by exactly the ratio between the two ranges.
     *
     * A picture at 0.1 mm and a picture at 0.6 mm are the cheapest way to notice.
     */
    const problems = await watchForShaderErrors(page);
    await openEditor(page);
    await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
    await confirmPreparation(page);
    await expect(page.getByTestId('artwork-name')).toBeVisible();
    await page.getByTestId('finish-emboss').click();

    await page.getByTestId('depth-slider').fill('0.1');
    await page.getByTestId('mode-look').click();
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    await page.waitForTimeout(4000);
    const shallow = await drawnPixels(page);

    await page.getByTestId('mode-place').click();
    await page.getByTestId('depth-slider').fill('0.6');
    await page.getByTestId('mode-look').click();
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    await page.waitForTimeout(4000);
    const deep = await drawnPixels(page);

    // Deeper relief casts more of everything: more slope, more occlusion, a bigger silhouette.
    expect(movedPixels(shallow, deep)).toBeGreaterThan(25);
    expect(problems()).toEqual([]);
  });

  test('follows the finish and the placement live, in Split, without a remount', async ({
    page,
  }) => {
    /*
     * The complaint this exists for: "the emboss/deboss buttons don't toggle the 3D view, and
     * moving the logo doesn't either."
     *
     * Every other test here switches Place -> Look between the change and the check, and switching
     * modes unmounts and rebuilds the viewport — which rebuilds every material and texture from
     * scratch and so cannot tell a live update from a fresh start. Split keeps both panes mounted,
     * which is where the work actually happens.
     */
    await openEditor(page);
    await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
    await confirmPreparation(page);
    await expect(page.getByTestId('artwork-name')).toBeVisible();
    await page.getByTestId('mode-split').click();
    await page.getByTestId('finish-emboss').click();
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    await page.waitForTimeout(4000);

    await expectViewportResponds(
      page,
      () => page.getByTestId('finish-deboss').click(),
      'the deboss button',
    );
    await page.getByTestId('snap-toggle').uncheck();
    await expectViewportResponds(
      page,
      () => page.getByTestId('input-x').fill('12'),
      'moving the mark',
    );
    await expectViewportResponds(
      page,
      () => page.getByTestId('finish-emboss').click(),
      'the emboss button',
    );
  });

  test('follows the finish live in Look, where the viewport is rebuilt for the larger pane', async ({
    page,
  }) => {
    /*
     * The Split test above covers Split; this covers Look, which is where relief is actually
     * inspected and which reaches it through a rebuild of the material set for the larger pane.
     *
     * Worth being plain about what this does *not* do. The bug that prompted it — the zone
     * textures being re-uploaded to a pair nothing sampled — only ever appeared under `next dev`,
     * because it came of a ref written during render and StrictMode invoking that render twice.
     * This suite builds and serves with `next start`, where React invokes it once, so neither this
     * test nor any other here could have failed on it. It is here for the production behaviour;
     * the development-only fault is prevented by not writing the ref at all.
     */
    await openEditor(page);
    await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
    await confirmPreparation(page);
    await expect(page.getByTestId('artwork-name')).toBeVisible();
    await page.getByTestId('mode-split').click();
    await page.getByTestId('finish-emboss').click();
    await page.getByTestId('mode-look').click();
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    await page.waitForTimeout(4000);

    // No mode switch, no camera move: the toggle alone has to reach the screen.
    await expectViewportResponds(
      page,
      () => page.getByTestId('finish-deboss').click(),
      'the deboss button',
    );
    await expectViewportResponds(
      page,
      () => page.getByTestId('finish-emboss').click(),
      'the emboss button',
    );
  });

  test('draws something different from a flat surface', async ({ page }) => {
    // The end of the argument: with artwork placed the frame must not be the frame without it.
    // Displaced geometry changes the silhouette and the occlusion, so the pixels have to move.
    await openEditor(page);
    await page.getByTestId('mode-look').click();
    await expect(page.getByTestId('viewport-3d')).toBeVisible();
    await page.waitForTimeout(4000);
    const bare = await drawnPixels(page);

    await page.getByTestId('mode-place').click();
    await page.getByTestId('artwork-upload').setInputFiles('fixtures/artwork/samples/wordmark.svg');
    await confirmPreparation(page);
    await expect(page.getByTestId('artwork-name')).toBeVisible();
    await page.getByTestId('finish-emboss').click();
    await page.getByTestId('mode-look').click();
    await expect.poll(async () => (await relief(page)).kind, { timeout: 20_000 }).toBe('displaced');
    await page.waitForTimeout(4000);
    const decorated = await drawnPixels(page);

    expect(movedPixels(bare, decorated)).toBeGreaterThan(25);
  });
});
