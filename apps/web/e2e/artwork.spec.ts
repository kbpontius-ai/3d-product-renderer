import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from './global-setup';
import type { StoredArtwork } from '../lib/editor-data';
import { initialArtworkEdit } from '../lib/artwork-edit-state';
import { openEditor, confirmPreparation } from './helpers';

test.skip(process.env['DEV_TOOLING'] !== 'true', 'needs the isolated e2e database');
test.use({ storageState: STORAGE_STATE });

let uploaded: string[];
let designs: string[];
test.beforeEach(async ({ page }) => {
  uploaded = [];
  designs = [];
  await page.goto('/artwork');
  await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
});
test.afterEach(async ({ page }) => {
  await page.evaluate(
    async ({ artworkIds, designIds }) => {
      await Promise.all(designIds.map((id) => fetch(`/api/designs/${id}`, { method: 'DELETE' })));
      await Promise.all(artworkIds.map((id) => fetch(`/api/artworks/${id}`, { method: 'DELETE' })));
    },
    { artworkIds: uploaded, designIds: designs },
  );
});

async function upload(page: Page, name: string): Promise<StoredArtwork> {
  const inset = 1 + Number.parseInt(randomUUID().slice(0, 8), 16) / 0xffffffff;
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="24mm" height="18mm" viewBox="0 0 24 18"><path d="M0 0L24 0L${inset} 18Z"/></svg>`;
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artworks/preparation') && response.request().method() === 'PUT',
  );
  await page
    .getByTestId('gallery-upload-input')
    .setInputFiles({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await confirmPreparation(page);
  const result = await response;
  expect(result.ok()).toBe(true);
  const artwork = (await result.json()) as StoredArtwork;
  uploaded.push(artwork.ref.artworkId);
  await expect(page.getByTestId(`artwork-tile-${artwork.ref.artworkId}`)).toBeVisible();
  return artwork;
}

async function open(page: Page, artwork: StoredArtwork) {
  await page
    .getByTestId(`artwork-tile-${artwork.ref.artworkId}`)
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('artwork-svg-preview')).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId('artwork-svg-preview')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
}

test('four-column gallery expands into the viewer and a bottom filmstrip without an upload button', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const entries = [];
  for (let i = 0; i < 4; i++) entries.push(await upload(page, `gallery-${randomUUID()}.svg`));
  const nav = page.getByTestId('app-nav').locator('.app-nav-links a');
  await expect(nav).toHaveText(['Designs', 'Artwork', 'Catalog', 'Renders']);
  await expect(page.getByTestId('nav-artwork')).toHaveAttribute('aria-current', 'page');
  const cards = page.getByTestId('artwork-gallery').locator('.artwork-tile');
  const bounds = await Promise.all([0, 1, 2, 3].map((i) => cards.nth(i).boundingBox()));
  expect(bounds.every((box) => Math.abs(box!.y - bounds[0]!.y) < 1)).toBe(true);
  await open(page, entries[0]!);
  await expect(page.getByTestId('gallery-upload')).toHaveCount(0);
  await expect(page.getByTestId('artwork-gallery')).toHaveCount(0);
  await expect(page.getByTestId('artwork-filmstrip')).toContainText(entries[1]!.name);
  await page.getByTestId('artwork-page').evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  const resizeHandle = await page.locator('.artwork-resize-handle').first().boundingBox();
  expect(resizeHandle!.height).toBe(10);
  expect(resizeHandle!.width).toBe(10);
  const editorBox = await page.getByTestId('artwork-editor').boundingBox();
  const stripBox = await page.getByTestId('artwork-filmstrip').boundingBox();
  expect(stripBox!.y).toBeGreaterThanOrEqual(editorBox!.y + editorBox!.height);
  expect(stripBox!.y + stripBox!.height).toBeLessThanOrEqual(900);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByTestId('artwork-zoom')).toHaveText('125%');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(page.getByTestId('artwork-zoom')).toHaveText('100%');
  const initialWidth = await page.getByTestId('artwork-edit-width').inputValue();
  const originalBounds = await page.getByTestId('artwork-svg-preview').boundingBox();
  const handle = await page.getByRole('button', { name: 'Resize artwork corner 4' }).boundingBox();
  await page.mouse.move(handle!.x + 5, handle!.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 35, handle!.y + 35, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByTestId('artwork-edit-width').inputValue()))
    .toBeGreaterThan(Number(initialWidth));
  await expect
    .poll(async () => (await page.getByTestId('artwork-svg-preview').boundingBox())!.width)
    .toBeGreaterThan(originalBounds!.width);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('artwork-edit-width')).toHaveValue(initialWidth);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByTestId('artwork-save')).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Back to artwork' }).click();
  await expect(page.getByTestId('gallery-upload')).toBeVisible();
});

test('shape edits persist a new version and leave the old SVG and mask unchanged', async ({
  page,
}) => {
  const artwork = await upload(page, `edit-${randomUUID()}.svg`);
  const before = await page.evaluate(
    async (url) => fetch(url).then((r) => r.text()),
    artwork.sourceUrl,
  );
  await open(page, artwork);
  await page.getByTestId('artwork-edit-name').fill('Edited artwork');
  await page.getByTestId('artwork-edit-width').fill('48');
  await expect(page.getByTestId('artwork-edit-height')).toHaveValue('36');
  await page.getByTestId('artwork-edit-rotation').fill('90');
  await page.getByRole('button', { name: 'Flip horizontal', exact: true }).click();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/artworks/${artwork.ref.artworkId}`) && r.request().method() === 'PUT',
  );
  await page.getByTestId('artwork-save').click();
  const savedResponse = await response;
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  const saved = (await savedResponse.json()) as StoredArtwork;
  expect(saved.ref.artworkId).toBe(artwork.ref.artworkId);
  expect(saved.ref.versionId).not.toBe(artwork.ref.versionId);
  expect(saved.naturalSizeMm.w).toBeCloseTo(36);
  expect(saved.naturalSizeMm.h).toBeCloseTo(48);
  expect(
    await page.evaluate(async (url) => fetch(url).then((r) => r.text()), artwork.sourceUrl),
  ).toBe(before);
  expect(
    await page.evaluate(async (url) => fetch(url).then((r) => r.status), artwork.maskUrl),
  ).toBe(200);
  await page.reload();
  await open(page, saved);
  await expect(page.getByTestId('artwork-edit-name')).toHaveValue('Edited artwork');
  await expect(page.getByTestId('artwork-edit-width')).toHaveValue('36');
  await expect(page.getByTestId('artwork-edit-height')).toHaveValue('48');
  await expect(page.getByTestId('artwork-save')).toBeDisabled();
});

test('undo/redo, validation and switching protect unsaved edits', async ({ page }) => {
  const first = await upload(page, `first-${randomUUID()}.svg`);
  const second = await upload(page, `second-${randomUUID()}.svg`);
  await open(page, first);
  await page.getByTestId('artwork-edit-width').fill('48');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('artwork-edit-width')).toHaveValue('24');
  await expect(page.getByTestId('artwork-save')).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByTestId('artwork-edit-width')).toHaveValue('48');
  await page.getByTestId('artwork-edit-width').fill('0');
  await expect(page.getByTestId('artwork-save')).toBeDisabled();
  await page.getByTestId('artwork-edit-width').fill('48');
  await page
    .getByTestId('artwork-filmstrip')
    .getByRole('button')
    .filter({ hasText: second.name })
    .click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Discard artwork changes?');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('artwork-edit-name')).toHaveValue(first.name);
  await page
    .getByTestId('artwork-filmstrip')
    .getByRole('button')
    .filter({ hasText: second.name })
    .click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('artwork-edit-name')).toHaveValue(second.name);
});

test('uploads reject live text and gallery actions rename, search and delete', async ({ page }) => {
  const artwork = await upload(page, `manage-${randomUUID()}.svg`);
  const tile = page.getByTestId(`artwork-tile-${artwork.ref.artworkId}`);
  await tile.getByRole('button', { name: 'Rename', exact: true }).click();
  const name = `Renamed ${randomUUID()}`;
  await page.getByTestId('confirm-input').fill(name);
  await page.getByTestId('confirm-accept').click();
  await expect(tile).toContainText(name);
  await page.getByTestId('artwork-search').fill(name);
  await expect(page.getByTestId('artwork-gallery').locator('.artwork-tile')).toHaveCount(1);
  await page
    .getByTestId('gallery-upload-input')
    .setInputFiles('fixtures/artwork/samples/text-not-outlined.svg');
  await expect(page.getByTestId('preparation-error')).toContainText('Convert text to outlines');
  await page.getByRole('button', { name: 'Back to artwork', exact: true }).click();
  await tile.locator('summary').click();
  await tile.getByRole('button', { name: 'Delete artwork', exact: true }).click();
  await page.getByTestId('confirm-accept').click();
  await expect(tile).toHaveCount(0);
});

test('the edit API rejects invalid inputs and stale versions', async ({ page }) => {
  const artwork = await upload(page, `api-${randomUUID()}.svg`);
  const edit = initialArtworkEdit(artwork);
  const status = async (body: unknown) =>
    page.evaluate(
      async ([id, body]) => {
        const response = await fetch(`/api/artworks/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return response.status;
      },
      [artwork.ref.artworkId, body] as const,
    );
  expect(await status({ ...edit, widthMm: -1 })).toBe(422);
  expect(await status({ ...edit, rotationDeg: 90 })).toBe(200);
  expect(await status({ ...edit, name: 'Stale' })).toBe(409);
});

test('signed-out visitors are sent to sign in with Artwork as the destination', async ({
  page,
  browser,
}) => {
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const visitor = await anonymous.newPage();
  await visitor.goto('/artwork');
  await expect(visitor).toHaveURL(/\/signin\?next=.*artwork/);
  await anonymous.close();
  await expect(page.getByTestId('nav-artwork')).toBeVisible();
});

test('a saved design keeps its pinned artwork after shape editing and prevents deletion', async ({
  page,
}) => {
  const artwork = await upload(page, `pinned-${randomUUID()}.svg`);
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  const url = page.url();
  const designId = new URL(url).pathname.split('/').pop()!;
  designs.push(designId);
  await openEditor(page, new URL(url).pathname);
  await page.getByTestId('artwork-library-toggle').click();
  await page.getByTestId(`library-${artwork.ref.versionId}`).click();
  const stored = () =>
    page.evaluate(
      async (id) =>
        fetch(`/api/designs/${id}`).then((r) => r.json()) as Promise<{
          document: { placements: { artwork: { versionId: string } }[] };
        }>,
      designId,
    );
  await expect
    .poll(async () => (await stored()).document.placements[0]?.artwork.versionId)
    .toBe(artwork.ref.versionId);
  const original = (await stored()).document;
  await page.goto('/artwork');
  await open(page, artwork);
  await page.getByTestId('artwork-edit-width').fill('48');
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes(artwork.ref.artworkId),
  );
  await page.getByTestId('artwork-save').click();
  expect((await saved).ok()).toBe(true);
  expect((await stored()).document).toEqual(original);
  await page.getByRole('button', { name: 'Delete artwork', exact: true }).click();
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId('artwork-page-error')).toContainText('still use');
  await openEditor(page, new URL(url).pathname);
  expect((await stored()).document).toEqual(original);
  await page.getByTestId('mode-place').click();
  await expect(page.getByTestId('face-view-canvas')).toBeVisible();
});
