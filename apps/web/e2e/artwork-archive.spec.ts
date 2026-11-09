import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from './global-setup';
import { openEditor } from './helpers';
import type { StoredArtwork } from '../lib/editor-data';

test.skip(process.env['DEV_TOOLING'] !== 'true', 'needs the isolated e2e database');
test.use({ storageState: STORAGE_STATE });

function browserRequest(page: Page) {
  const request = async (
    method: string,
    url: string,
    options: { data?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const result = await page.evaluate(
      async ({ method, url, options }) => {
        const response = await fetch(url, {
          method,
          headers: options.headers ?? { 'content-type': 'application/json' },
          ...(options.data !== undefined
            ? {
                body:
                  typeof options.data === 'string' ? options.data : JSON.stringify(options.data),
              }
            : {}),
        });
        return {
          ok: response.ok,
          status: response.status,
          body: response.status === 204 ? null : await response.json(),
        };
      },
      { method, url, options },
    );
    return { ok: () => result.ok, status: () => result.status, json: async () => result.body };
  };
  return {
    get: (url: string) => request('GET', url),
    post: (url: string, options?: { data?: unknown; headers?: Record<string, string> }) =>
      request('POST', url, options),
    patch: (url: string, options?: { data?: unknown }) => request('PATCH', url, options),
    delete: (url: string) => request('DELETE', url),
  };
}

async function fixture(page: Page) {
  await page.goto('/artwork');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10"><path d="M0 0L20 0L${Math.random()} 10Z"/></svg>`;
  const response = await browserRequest(page).post('/api/artworks', {
    headers: { 'content-type': 'image/svg+xml', 'x-artwork-name': `archive-${randomUUID()}` },
    data: svg,
  });
  expect(response.ok()).toBe(true);
  const artwork = (await response.json()) as StoredArtwork;
  const { products } = (await (await browserRequest(page).get('/api/catalog/products')).json()) as {
    products: { productKey: string; variants: { variantId: string }[] }[];
  };
  const variantId = products.find((p) => p.productKey === 'cap-flat')!.variants[0]!.variantId;
  const created = await browserRequest(page).post('/api/designs', {
    data: { variantId, name: `Archive design ${randomUUID()}` },
  });
  const design = (await created.json()) as { id: string; document: Record<string, unknown> };
  const saved = await browserRequest(page).patch(`/api/designs/${design.id}`, {
    data: {
      expectedVersion: 1,
      document: {
        ...design.document,
        placements: [
          {
            id: randomUUID(),
            zoneKey: 'top',
            artwork: artwork.ref,
            transform: {
              offsetMm: { x: 0, y: 0 },
              sizeMm: { w: 18, h: 9 },
              rotationDeg: 0,
              flipX: false,
              flipY: false,
              lockAspect: true,
            },
            finish: { kind: 'deboss', depthMm: 0.2, bevelDeg: 20, edgeRadiusMm: 0.05 },
            order: 0,
          },
        ],
      },
    },
  });
  expect(saved.ok()).toBe(true);
  return { artwork, design };
}

test('archive confirmation, hidden picker, amber banner, usable inspection and restore', async ({
  page,
}, info) => {
  const { artwork, design } = await fixture(page);
  try {
    await page.reload();
    const tile = page.getByTestId(`artwork-tile-${artwork.ref.artworkId}`);
    await tile.locator('summary').click();
    await tile.getByRole('button', { name: 'Archive artwork', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('1 saved design will become view-only');
    await page.screenshot({ path: info.outputPath('archive-confirmation.png') });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Archive artwork', exact: true })
      .click();
    await expect(tile).toHaveCount(0);
    const active = (await (await browserRequest(page).get('/api/artworks')).json()) as {
      artworks: StoredArtwork[];
    };
    expect(active.artworks.some((a) => a.ref.artworkId === artwork.ref.artworkId)).toBe(false);
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(tile).toContainText('Restore artwork');
    await page.screenshot({ path: info.outputPath('archived-gallery.png') });
    await page.goto('/designs');
    const card = page.getByTestId(`design-${design.id}`);
    await expect(card).toContainText('Archived artwork · View-only');
    await card.locator('summary').click();
    await expect(card.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Duplicate', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
    await openEditor(page, `/design/${design.id}`);
    await expect(page.getByTestId('archive-banner')).toContainText('this design is view-only');
    expect(
      await page.getByTestId('archive-banner').evaluate((e) => getComputedStyle(e).backgroundColor),
    ).toBe('rgb(255, 245, 228)');
    await expect(page.getByTestId('input-x')).toBeDisabled();
    await expect(page.getByTestId('reorient-product')).toBeDisabled();
    await expect(page.getByTestId('open-render-settings')).toBeDisabled();
    await expect(page.getByTestId('artwork-library-toggle')).toBeDisabled();
    const before = await (await browserRequest(page).get(`/api/designs/${design.id}`)).json();
    await page.getByTestId('mode-look').click();
    await page.getByRole('button', { name: 'Front', exact: true }).click();
    await page.getByTestId('inspect-artwork').click();
    await page.getByTestId('inspection-rotation').fill('45');
    await expect(page.getByTestId('inspection-rotation')).toHaveValue('45');
    await page.getByRole('button', { name: 'Top', exact: true }).click();
    await page.getByRole('button', { name: 'Three-quarter', exact: true }).click();
    await expect(page.getByTestId('snapshot-button')).toBeEnabled();
    await expect(page.getByTestId('viewport-loading')).toHaveCount(0);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }));
    const snapshot = page.waitForEvent('download');
    await page.getByTestId('snapshot-button').click();
    expect((await snapshot).suggestedFilename()).toMatch(/-snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.png$/);
    await expect
      .poll(
        async () =>
          (await (await browserRequest(page).get(`/api/designs/${design.id}`)).json()).version,
      )
      .toBe(before.version);
    expect(
      (await (await browserRequest(page).get(`/api/designs/${design.id}`)).json()).document,
    ).toEqual(before.document);
    await page.screenshot({ path: info.outputPath('archived-design.png') });
    const render = await browserRequest(page).post(`/api/designs/${design.id}/renders`, {
      data: {},
    });
    expect(render.status()).toBe(409);
    await page.getByRole('link', { name: 'View artwork' }).click();
    await expect(page.getByTestId('archive-banner')).toContainText('Artwork archived');
    await expect(page.getByTestId('artwork-edit-name')).toBeDisabled();
    await expect(page.getByTestId('artwork-save')).toBeDisabled();
    await expect(page.locator('.artwork-resize-handle')).toHaveCount(0);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.getByTestId('artwork-zoom')).toHaveText('125%');
    await page.getByRole('button', { name: 'Restore artwork', exact: true }).click();
    await expect(page.getByTestId('artwork-message')).toContainText('Artwork restored');
    await openEditor(page, `/design/${design.id}`);
    await expect(page.getByTestId('archive-banner')).toHaveCount(0);
    await expect(page.getByTestId('input-x')).toBeEnabled();
    await expect(page.getByTestId('open-render-settings')).toBeEnabled();
  } finally {
    await browserRequest(page).delete(`/api/designs/${design.id}`);
    await browserRequest(page).delete(`/api/artworks/${artwork.ref.artworkId}`);
  }
});

test('an archived SVG preserves pending edits and can be restored without discarding them', async ({
  page,
}) => {
  const { artwork, design } = await fixture(page);
  try {
    await page.goto(`/artwork?artworkId=${artwork.ref.artworkId}`);
    await expect(page.getByTestId('artwork-svg-preview')).toBeVisible();
    const changedName = `Pending ${randomUUID()}`;
    await page.getByTestId('artwork-edit-name').fill(changedName);
    await browserRequest(page).post(`/api/artworks/${artwork.ref.artworkId}/archive`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('archive-banner')).toContainText('unsaved local changes');
    await expect(page.getByTestId('artwork-edit-name')).toBeDisabled();
    await expect(page.getByTestId('artwork-edit-name')).toHaveValue(changedName);
    await browserRequest(page).delete(`/api/artworks/${artwork.ref.artworkId}/archive`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('archive-banner')).toHaveCount(0);
    await expect(page.getByTestId('artwork-edit-name')).toBeEnabled();
    await expect(page.getByTestId('artwork-edit-name')).toHaveValue(changedName);
    await page.getByTestId('artwork-save').click();
    await expect(page.locator('.artwork-workspace-name')).toHaveText(changedName);
  } finally {
    await browserRequest(page).delete(`/api/designs/${design.id}`);
    await browserRequest(page).delete(`/api/artworks/${artwork.ref.artworkId}`);
  }
});

test('a stale tab freezes unsaved work on archive rejection and refreshes after restore', async ({
  page,
}) => {
  const { artwork, design } = await fixture(page);
  try {
    await openEditor(page, `/design/${design.id}`);
    await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
    await browserRequest(page).post(`/api/artworks/${artwork.ref.artworkId}/archive`);
    await page.getByTestId('input-x').fill('1');
    await expect(page.getByTestId('archive-banner')).toBeVisible();
    await expect(page.getByTestId('input-x')).toBeDisabled();
    await expect(page.getByTestId('input-x')).toHaveValue('1.00');
    const stored = await (await browserRequest(page).get(`/api/designs/${design.id}`)).json();
    expect(stored.document.placements[0].transform.offsetMm.x).toBe(0);
    await browserRequest(page).delete(`/api/artworks/${artwork.ref.artworkId}/archive`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('archive-banner')).toHaveCount(0);
    await expect(page.getByTestId('input-x')).toBeEnabled();
    await expect
      .poll(
        async () =>
          (await (await browserRequest(page).get(`/api/designs/${design.id}`)).json()).document
            .placements[0].transform.offsetMm.x,
      )
      .toBe(1);
  } finally {
    await browserRequest(page).delete(`/api/designs/${design.id}`);
    await browserRequest(page).delete(`/api/artworks/${artwork.ref.artworkId}`);
  }
});
