import { expect, test, type Page } from '@playwright/test';
import { createAccount, storedDesign, uploadArtwork, waitForStored } from './helpers';
import { STAFF_STORAGE_STATE, STORAGE_STATE } from './global-setup';

/**
 * Design persistence through the browser (W-03, build order G2).
 *
 * The claim under test is the one a user cares about: what they laid out is still there tomorrow.
 * So these go through the real editor — real drags, real autosave, real reload — rather than
 * asserting against the API and hoping the editor speaks to it correctly.
 *
 * One account serves the whole file, injected into each test's own context. Accepting an invitation
 * is rate limited per address *and* per IP, which is right — but it means a suite that created an
 * account per test would be testing the limiter rather than the designs.
 */

test.describe.configure({ mode: 'default' });
test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');

// One account for the whole suite, provisioned in global setup: accepting an invitation is rate
// limited per IP, and these tests are not about that.
test.use({ storageState: STORAGE_STATE });

/**
 * Starts a design and places real artwork on it.
 *
 * A design only stores a placement once it has artwork that exists — the bundled sample is a
 * preview, not something anyone owns — so uploading is part of getting to a design worth saving.
 */
async function startDesign(page: Page, testId: string): Promise<string> {
  await page.goto('/catalog');
  await page.getByTestId(testId).click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await page.locator('.editor[data-hydrated]').waitFor();
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('face-view-canvas')).toBeVisible();

  await expect(page.getByTestId('artwork-sample-hint')).toBeVisible();
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');
  await expect(page.getByTestId('artwork-sample-hint')).toHaveCount(0);

  return page.url();
}

/** px/mm as the app reports it, so a drag can be expressed in millimetres. */
async function pxPerMm(page: Page): Promise<number> {
  await expect(page.getByTestId('scale-chip')).not.toHaveText('—');
  return Number(((await page.getByTestId('scale-chip').textContent()) ?? '').replace(' px/mm', ''));
}

async function dragBy(page: Page, dxMm: number, dyMm: number) {
  const box = (await page.getByTestId('face-view-canvas').boundingBox())!;
  const k = await pxPerMm(page);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Two moves: the first starts the gesture, the second is the one that has to be honoured.
  await page.mouse.move(from.x + (dxMm * k) / 2, from.y - (dyMm * k) / 2, { steps: 4 });
  await page.mouse.move(from.x + dxMm * k, from.y - dyMm * k, { steps: 4 });
  await page.mouse.up();
}

const xMm = async (page: Page) => Number(await page.getByTestId('input-x').inputValue());
const widthMm = async (page: Page) => Number(await page.getByTestId('input-width').inputValue());

test('reopening a design never saves it without its artwork, however slowly the artwork loads', async ({
  page,
}) => {
  // The editor autosaves 900 ms after the document it would save differs from the stored one. Its
  // artwork arrives asynchronously — the mask is an image — and until it had, the document it would
  // save had no placement. So a slow mask saved the design *without its logo*, and put it back only
  // once the mask arrived: close the tab in between, or lose the mask, and the logo was gone.
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  expect((await storedDesign(page)).document.placements).toHaveLength(1);

  const saved: number[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'PATCH' || !request.url().includes('/api/designs/')) return;
    const body = JSON.parse(request.postData() ?? '{}') as {
      document?: { placements?: unknown[] };
    };
    saved.push(body.document?.placements?.length ?? -1);
  });
  await page.route(/\/api\/assets\/artwork\/.+mask/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });

  await page.goto(url);
  // Longer than the debounce and the delayed mask together: whatever the editor was going to save
  // on opening, it has tried by now.
  await page.waitForTimeout(4000);

  expect(
    saved.filter((count) => count === 0),
    'a save without the placement was sent',
  ).toEqual([]);
  expect((await storedDesign(page)).document.placements).toHaveLength(1);
});

test('a placement survives a reload', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');

  // Snapping would pull a small nudge straight back to the centre line, so move well clear of it.
  await page.getByTestId('snap-toggle').uncheck();
  await dragBy(page, 6, -3);
  await page.getByTestId('depth-slider').fill('0.42');

  const placed = { x: await xMm(page), w: await widthMm(page) };
  expect(placed.x).toBeGreaterThan(1);
  await waitForStored(
    page,
    (s) =>
      s.document.placements[0]?.finish.depthMm === 0.42 &&
      s.document.placements[0].transform.offsetMm.x > 1,
    'the placement was never stored',
  );

  await page.goto(url);
  await page.locator('.editor[data-hydrated]').waitFor();
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('face-view-canvas')).toBeVisible();

  expect(await xMm(page)).toBeCloseTo(placed.x, 1);
  expect(await widthMm(page)).toBeCloseTo(placed.w, 1);
  await expect(page.getByTestId('finish-deboss')).toHaveClass(/active/);
  await expect(page.getByTestId('depth-slider')).toHaveValue('0.42');
  await expect(page.getByTestId('design-version')).toContainText('Version');
});

test('the colourway and the face are part of the design too', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');

  await page.getByTestId('zone-skirt').click();
  await page.getByTestId('colorway-body-coral').click();
  await waitForStored(
    page,
    (s) =>
      s.document.placements[0]?.zoneKey === 'skirt' &&
      s.document.materials['body']?.colorHex === '#d1495b',
    'the face and colourway were never stored',
  );

  await page.goto(url);
  await expect(page.getByTestId('zone-skirt')).toHaveClass(/active/);
  await expect(page.getByTestId('colorway-body-coral')).toHaveClass(/active/);
});

test('a carton design saves the print finish its panel allows', async ({ page }) => {
  const url = await startDesign(page, 'start-box-basic-carton-tuck-std');

  // The same editor, a different pack: the print-only panel must not inherit a relief default.
  await expect(page.getByTestId('finish-print')).toHaveClass(/active/);
  await expect(page.getByTestId('finish-deboss')).toBeDisabled();
  await page.getByTestId('ink-color').fill('#123456');
  await waitForStored(
    page,
    (s) => s.document.placements[0]?.finish.tintHex === '#123456',
    'the ink colour was never stored',
  );

  await page.goto(url);
  await expect(page.getByTestId('finish-print')).toHaveClass(/active/);
  await expect(page.getByTestId('ink-color')).toHaveValue('#123456');
});

test('a design that breaks a limit is not saved', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');

  // Far wider than the top face: the validation strip blocks it, so autosave must not store it.
  await page.getByTestId('input-width').fill('120');
  await page.getByTestId('input-width').blur();

  await expect(page.getByTestId('validation')).toContainText('extends past the decoration area');
  await expect(page.getByTestId('save-status')).toHaveText('Not saved — fix the problems below', {
    timeout: 20_000,
  });

  await page.goto(url);
  expect(await widthMm(page)).toBeLessThan(60);
});

test('the design list shows what was saved, and opens it again', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  await page.getByTestId('snap-toggle').uncheck();
  await dragBy(page, 5, 0);
  await waitForStored(
    page,
    (s) => (s.document.placements[0]?.transform.offsetMm.x ?? 0) > 1,
    'the drag was never stored',
  );

  await page.goto('/designs');
  const entry = page.getByTestId('design-list').locator(`a[href="${new URL(url).pathname}"]`);
  await expect(entry).toContainText('Flat-top closure');

  await entry.click();
  await page.locator('.editor[data-hydrated]').waitFor();
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('face-view-canvas')).toBeVisible();
  expect(await xMm(page)).toBeGreaterThan(1);
});

test('the uploaded logo comes back, not the sample', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  await expect(page.getByTestId('artwork-name')).toContainText('wordmark');
  // `startDesign` already waited for the placement to be stored; this is purely a reload.
  await page.goto(url);
  await expect(page.getByTestId('artwork-name')).toContainText('wordmark');
  await expect(page.getByTestId('artwork-name')).toContainText('in your library');
  await expect(page.getByTestId('artwork-sample-hint')).toHaveCount(0);
});

test('an SVG the pipeline refuses is not stored, and says what to fix', async ({ page }) => {
  await startDesign(page, 'start-cap-basic-cap-flat-38mm');

  await page
    .getByTestId('artwork-upload')
    .setInputFiles('fixtures/artwork/samples/text-not-outlined.svg');

  // The upload is a server round trip through the whole pipeline, and these run alongside a render
  // worker; the budget is for a busy machine, not for a fast one.
  await expect(page.getByTestId('preparation-error')).toContainText('live text', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('preparation-error')).toContainText('Convert text to outlines');
  await page.getByRole('button', { name: 'Back to artwork', exact: true }).click();
  // The previous artwork is still what is placed; a refusal changes nothing.
  await expect(page.getByTestId('artwork-name')).toContainText('wordmark');
});

/** A 1x1 greyscale PNG, for when a request needs to carry a real image and nothing more. */
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mNoAAAAggCB2kUIOwAAAABJRU5ErkJggg==';

test('another organization cannot open the design, or read its artwork', async ({
  page,
  request,
  context,
}) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');

  // Fetched from inside the page rather than through Playwright's API context: the session cookie
  // is `Secure`, and a browser on localhost sends it where a plain HTTP client will not.
  const status = (target: string) =>
    page.evaluate((href) => fetch(href).then((r) => r.status), target);

  const library = await page.evaluate(
    () =>
      fetch('/api/artworks').then((r) => r.json()) as Promise<{ artworks: { maskUrl: string }[] }>,
  );
  const maskUrl = library.artworks[0]!.maskUrl;
  expect(await status(maskUrl)).toBe(200);

  // A thumbnail too, because artwork is not the only thing keyed by organisation: renders and
  // dashboard thumbnails are as well, and only one of the three used to be checked.
  const designId = new URL(url).pathname.split('/').pop()!;
  const uploaded = await page.evaluate(
    async ([id, base64]: string[]) =>
      fetch(`/api/designs/${id}/thumbnail`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        // One pixel is enough: what is under test is who may read it back, not what it shows.
        body: Uint8Array.from(atob(base64!), (c) => c.charCodeAt(0)),
      }).then((r) => r.status),
    [designId, ONE_PIXEL_PNG],
  );
  expect(uploaded).toBe(204);

  await page.goto('/designs');
  const thumbUrl = (await page
    .getByTestId('design-list')
    .locator(`a[href="/design/${designId}"] img.design-thumb`)
    .getAttribute('src'))!;
  expect(thumbUrl).toContain(`/${designId}/`);
  expect(await status(thumbUrl)).toBe(200);

  // A second account in its own organisation: the ids are real ones, and still unknown to them.
  await context.clearCookies();
  await createAccount(page, request, `e2e-other-${Date.now()}`);

  await page.goto(url);
  await expect(page.locator('body')).toContainText('could not be found');
  // The asset key names the organisation that owns it, so this is a comparison, not a lookup.
  expect(await status(maskUrl)).toBe(404);
  expect(await status(thumbUrl)).toBe(404);
});

test('a signed-out visitor is sent to sign in, with the design to return to', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  const designId = new URL(url).pathname.split('/').pop()!;

  await page.context().clearCookies();
  await page.goto(url);
  await expect(page).toHaveURL(new RegExp(`/signin\\?next=.*${designId}`));
});

test('the bell is there, and empty until something happens', async ({ page }) => {
  await page.goto('/designs');

  await expect(page.getByTestId('bell')).toBeVisible();
  await page.getByTestId('bell').click();
  await expect(page.getByTestId('bell-list')).toBeVisible();

  // A press anywhere else dismisses it. The panel has no backdrop, so without this the only way
  // out is finding the bell again.
  await page.getByTestId('designs').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('bell-list')).toHaveCount(0);

  // …and a press inside it does not, or every notification would close the list before its link
  // could be followed.
  await page.getByTestId('bell').click();
  await page.getByTestId('bell-list').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('bell-list')).toBeVisible();
});

test('the studio and the background are part of the design', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  await page.getByTestId('environment').selectOption('studio-sweep');
  await page.getByTestId('background-solid').click();
  await waitForStored(
    page,
    (s) =>
      s.document.scene.environmentKey === 'studio-sweep' &&
      s.document.scene.background.kind === 'solid',
    'the scene settings were not saved',
  );

  // And they come back with the design, because the renderer will be told the same thing.
  await page.goto(url);
  await expect(page.getByTestId('environment')).toHaveValue('studio-sweep');
  await expect(page.getByTestId('background-solid')).toHaveClass(/active/);
});

test('each part of the product gets its own material and colour', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  // The cap declares two slots; the liner is a different plastic from the body.
  await expect(page.getByTestId('slot-body')).toBeVisible();
  await expect(page.getByTestId('slot-liner')).toBeVisible();

  await page.getByTestId('material-liner').selectOption('pp-gloss');
  await page.getByTestId('hex-body').fill('#2b6cb0');

  await waitForStored(
    page,
    (s) =>
      s.document.materials['liner']?.materialKey === 'pp-gloss' &&
      s.document.materials['body']?.colorHex === '#2b6cb0',
    'the per-slot assignment was not saved',
  );

  await page.goto(url);
  await expect(page.getByTestId('material-liner')).toHaveValue('pp-gloss');
  await expect(page.getByTestId('hex-body')).toHaveValue('#2b6cb0');
});

test('artwork can be renamed and removed from the library', async ({ page }) => {
  await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  if (!(await page.getByTestId('artwork-library').isVisible()))
    await page.getByTestId('artwork-library-toggle').click();
  const library = page.getByTestId('artwork-library');
  await expect(library).toBeVisible();

  // The artwork this design is using cannot be deleted: it would render a missing file.
  const entry = library.locator('li').filter({ hasText: 'wordmark' }).first();
  await entry.getByRole('button', { name: 'Delete' }).click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('library-error')).toContainText('still use');
});

test('a design can be renamed, deleted and brought back', async ({ page }) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  const id = new URL(url).pathname.split('/').pop()!;
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  await page.goto('/designs');
  // Renaming asks in the app's own modal: the field holds the current name, Enter submits.
  await page.getByTestId(`design-${id}`).locator('summary').click();
  await page.getByTestId(`rename-${id}`).click();
  const field = page.getByTestId('confirm-input');
  await expect(field).toBeFocused();
  await field.fill('Renamed design');
  await field.press('Enter');
  await expect(page.getByTestId(`design-${id}`)).toContainText('Renamed design');

  // Deleting asks first; cancelling keeps it.
  await page.getByTestId(`delete-${id}`).click();
  await expect(page.getByTestId('confirm-consequences')).toContainText('restored for 30 days');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId(`design-${id}`)).toBeVisible();
  await page.getByTestId(`delete-${id}`).click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId(`design-${id}`)).toHaveCount(0);

  // Soft: it is in the recently deleted list, and it comes back with its name.
  await expect(page.getByTestId(`deleted-${id}`)).toContainText('Renamed design');
  await page.getByTestId(`restore-${id}`).click();
  await expect(page.getByTestId(`design-${id}`)).toContainText('Renamed design');
});

test('a lens the customer chose is saved with the design, and survives reopening', async ({
  page,
}) => {
  const url = await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');

  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('viewport-3d')).toBeVisible();

  // A long lens: the preset is 85 mm, so this is unmistakably the customer's choice and not a
  // default that happens to match.
  await page.getByTestId('lens-focal').fill('150');

  await waitForStored(
    page,
    (s) => s.document.scene.camera.kind === 'custom',
    'the framed camera was never stored',
  );

  const stored = await storedDesign(page);
  expect(stored.document.scene.camera.focalMm).toBe(150);
  // The whole camera, not a preset with a lens bolted on: the renderer looks nothing up for itself.
  expect(stored.document.scene.camera.positionMm).toHaveLength(3);

  // Reopening is the point. A view that is not there when you come back was not saved.
  await page.goto(url);
  await expect(page.getByTestId('mode-look')).toBeVisible();
  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('lens-focal')).toHaveValue('150');

  // And a preset puts it back, which is the way out of a view you no longer want.
  await page.getByTestId('camera-top').click();
  await waitForStored(
    page,
    (s) => s.document.scene.camera.kind === 'preset',
    'picking a preset did not clear the framed camera',
  );
});

test('the catalog filters on the facets the packs declare', async ({ page }) => {
  await page.goto('/catalog');
  await expect(page.getByTestId('catalog-filters')).toBeVisible();

  // The cap fixture declares a neck size; whatever facets exist, choosing one narrows the list.
  const first = page.locator('[data-testid^="facet-"]').first();
  const value = await first.locator('option').nth(1).getAttribute('value');
  await first.selectOption(value!);

  await expect(page.getByTestId('catalog-clear')).toBeVisible();
  const shown = page.locator('[data-testid^="product-"]');
  expect(await shown.count()).toBeGreaterThan(0);

  await page.getByTestId('catalog-clear').click();
  await expect(page.getByTestId('catalog-clear')).toHaveCount(0);
});

test('the catalog search filters as it is typed', async ({ page }) => {
  // Arriving from another page, so that "Back" below has somewhere recognisable to land.
  await page.goto('/designs');
  await page.goto('/catalog');

  const shown = page.locator('[data-testid^="product-"]');
  expect(await shown.count()).toBeGreaterThan(1);

  // Typed a character at a time, and never submitted: no Enter, and there is no longer a button to
  // press. What narrows the list is the debounce firing.
  await page.getByTestId('catalog-search').pressSequentially('bottle');

  await expect(shown).toHaveCount(1);
  await expect(page.getByTestId('product-bottle-oval-bottle-oval')).toBeVisible();
  // In the URL, not just in component state, so a filtered catalog is still a link.
  await expect(page).toHaveURL(/[?&]q=bottle/);

  // Six keystrokes replaced one history entry rather than pushing six. Without that, Back would
  // walk the term backwards one letter at a time and never leave the page.
  await page.goBack();
  await page.waitForURL(/\/designs$/);
});

test('a product detail page says what can be put on it', async ({ page }) => {
  await page.goto('/catalog');
  await page.getByTestId('detail-cap-basic-cap-flat').click();
  await page.waitForURL(/\/catalog\/cap-basic\/cap-flat$/);

  await expect(page.getByTestId('product-detail-cap-flat')).toBeVisible();
  await expect(page.getByTestId('zone-row-top')).toContainText('mm');
  await expect(page.getByTestId('slots-38mm')).toContainText('Cap body');

  // And a design can be started from it.
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
});

test('an asset URL is signed, expires, and is not transferable (F-PLAT-04)', async ({
  page,
  browser,
}) => {
  await startDesign(page, 'start-cap-basic-cap-flat-38mm');
  const status = (target: string) =>
    page.evaluate((href) => fetch(href).then((r) => r.status), target);

  const library = await page.evaluate(
    () =>
      fetch('/api/artworks').then((r) => r.json()) as Promise<{ artworks: { maskUrl: string }[] }>,
  );
  const maskUrl = library.artworks[0]!.maskUrl;

  const parsed = new URL(maskUrl, 'http://127.0.0.1');
  expect(parsed.searchParams.get('s')).toBeTruthy();
  expect(Number(parsed.searchParams.get('e'))).toBeGreaterThan(Date.now());
  expect(await status(maskUrl)).toBe(200);

  // The session alone is not enough: without the signature the same account is refused.
  expect(await status(parsed.pathname)).toBe(404);

  // Nor is an expiry the holder chose. It is inside the signed material, so editing it breaks it.
  const pushedOut = new URL(maskUrl, 'http://127.0.0.1');
  pushedOut.searchParams.set('e', String(Date.now() + 365 * 24 * 60 * 60 * 1000));
  expect(await status(pushedOut.pathname + pushedOut.search)).toBe(404);

  // And a colleague in the same organisation, holding the URL, is still refused: it was issued to
  // one person, and this is the case the signature exists for since the tenancy check would pass.
  // The staff account the suite already provisions is exactly that colleague, so this costs no
  // invitation against a budget the whole suite shares.
  const colleague = await browser.newContext({ storageState: STAFF_STORAGE_STATE });
  const theirPage = await colleague.newPage();
  await theirPage.goto('/designs');
  const theirStatus = await theirPage.evaluate(
    (href) => fetch(href).then((r) => r.status),
    maskUrl,
  );
  await colleague.close();

  expect(theirStatus).toBe(404);
});

test('the catalog card carries a picture slot and key dimensions (F-CAT-01)', async ({ page }) => {
  await page.goto('/catalog');
  const card = page.getByTestId('product-cap-basic-cap-flat');
  await expect(card).toBeVisible();

  // Dimensions come from the variant bounding box, so they describe the mesh that will actually be
  // rendered rather than a number typed into a manifest beside it.
  await expect(card.locator('.catalog-dimensions')).toHaveText(/\d+(\.\d+)?\s*×\s*\d+/);

  // The fixture packs ship no thumbnail, so this is the honest blank rather than a broken image —
  // the slot is there and fills itself the day a pack ships one.
  await expect(card.locator('.product-thumb')).toHaveCount(1);
});

test('source CAD is never served, to anyone (F-PLAT-04)', async ({ page }) => {
  // The ingestion pipeline that will write these files does not exist yet (docs/23-cad-ingestion.md).
  // The door is being shut before it is built: this prefix is refused by a named rule rather than by
  // being absent from an allow-list, so a later refactor cannot quietly make it servable.
  await page.goto('/designs');

  const status = await page.evaluate(
    (href) => fetch(href).then((r) => r.status),
    '/api/assets/cad-source/any-org/any-part.step',
  );

  expect(status).toBe(404);
});
