import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { makeZip } from '@pr/packfile';
import type { PackManifest } from '@pr/design-schema';
import { storedDesign, uploadArtwork, waitForOrientationModel, waitForStored } from './helpers';
import { ORIENTATION_STAFF_STORAGE_STATE, STORAGE_STATE } from './global-setup';

const failures: string[] = [];
test.beforeEach(({ page }) => {
  failures.length = 0;
  page.on('pageerror', (error) => failures.push(error.stack ?? error.message));
});
test.afterEach(() => {
  expect(failures).toEqual([]);
});

test('reorientation uses the guided steps, real preview and preserves demo placement', async ({
  page,
}, testInfo) => {
  await page.goto('/design/demo');
  await page.getByTestId('reorient-product').click();
  await expect(page.getByTestId('orientation-wizard')).toHaveAttribute('data-step', '1');
  await expect(page.getByTestId('orientation-front-preview').locator('canvas')).toBeVisible();
  await waitForOrientationModel(page);
  for (const key of ['front', 'top', 'three-quarter'])
    await page.getByTestId(`orientation-view-${key}`).click();
  await page.getByTestId('orientation-view-top').click();
  await page.getByTestId('orientation-current-view').click();
  await page.getByTestId('orientation-view-three-quarter').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('orientation-setup.png') });
  await page.getByTestId('orientation-flip').click();
  await page.getByTestId('orientation-flip').click();
  await page.getByTestId('orientation-turn').click();
  await page.getByTestId('orientation-show-plane').uncheck();
  await page.getByTestId('orientation-confirm').click();
  await expect(page.getByTestId('orientation-wizard')).toHaveAttribute('data-step', '2');
  await expect(
    page.getByText('Review existing decoration zones. Their physical geometry is read-only here.'),
  ).toBeVisible();
  await page.getByTestId('orientation-review').click();
  await page.getByTestId('orientation-finish').click();
  await expect(page.getByTestId('reorient-product')).toBeVisible();
  await page.getByTestId('mode-look').click();
  await expect(page.getByTestId('camera-reset')).toBeVisible();
  expect(failures).toEqual([]);
});

test('closing reorientation discards its candidate and inspection stays temporary', async ({
  page,
}) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url());
  });
  await page.goto('/design/demo');
  await page.getByTestId('reorient-product').click();
  await page.getByTestId('orientation-turn').click();
  await page.getByRole('button', { name: 'Close setup' }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByTestId('inspection-rotation')).toHaveValue('0');
  await expect(page.getByTestId('inspection-reset')).toBeVisible();
  await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('inspect-artwork').click();
  await expect(page.getByTestId('inspection-rotation')).toBeVisible();
  await page.getByTestId('inspection-rotation').fill('90');
  await page.getByTestId('design-lighting').click();
  await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('inspection-rotation')).toHaveCount(0);
  await page.getByTestId('inspect-artwork').click();
  await expect(page.getByTestId('inspection-rotation')).toHaveValue('90');
  await page.getByTestId('inspection-rotation').fill('-45');
  await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('inspection-reset').click();
  await expect(page.getByTestId('inspection-rotation')).toHaveValue('0');
  expect(writes).toEqual([]);
});

test.describe('staff product setup', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'requires isolated staff test account');
  test.use({ storageState: ORIENTATION_STAFF_STORAGE_STATE });
  test('confirms a draft frame, resumes it and publishes without modifying its geometry', async ({
    page,
  }) => {
    // Loads the model three times over: the wizard, its resume, and the catalog preview.
    test.slow();
    const manifest = JSON.parse(
      await readFile('fixtures/packs/cap-basic/manifest.json', 'utf8'),
    ) as PackManifest;
    manifest.key = `orientation-${randomBytes(4).toString('hex')}`;
    const targetSlot = manifest.products[0]!.variants[0]!.materialSlots[0]!.key;
    manifest.products[0]!.variants[0]!.materialSlots.unshift({
      ...manifest.products[0]!.variants[0]!.materialSlots[0]!,
      key: 'empty-assembly',
      label: 'Empty assembly',
    });
    manifest.products[0]!.variants[0]!.presentationOrientation = {
      version: 1,
      frontSource: [0, 0, 1],
      upSource: [0, 1, 0],
      confirmed: false,
    };
    const paths = [
      ...new Set(
        manifest.products.flatMap((p) =>
          p.variants.flatMap((v) => Object.values(v.assets).map((a) => a.path)),
        ),
      ),
    ];
    const zip = makeZip([
      { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
      ...(await Promise.all(
        paths.map(async (path) => ({
          path,
          bytes: await readFile(`fixtures/packs/cap-basic/${path}`),
        })),
      )),
    ]);
    await page.goto('/admin/packs');
    await page.getByTestId('pack-file').setInputFiles({
      name: 'orientation.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zip),
    });
    await page.getByTestId('pack-import-draft').click();
    const pack = page.getByTestId(`pack-${manifest.key}-${manifest.version}`);
    await expect(pack).toBeVisible();
    await pack.getByRole('link', { name: 'Orientation', exact: true }).click();
    const id = new URL(page.url()).pathname.split('/')[3]!;
    try {
      await waitForOrientationModel(page);
      await page.getByTestId('orientation-view-top').click();
      await page.getByTestId('orientation-current-view').click();
      await page.getByTestId('orientation-confirm').click();
      await expect(page.getByTestId('orientation-wizard')).toHaveAttribute('data-step', '2');
      await page.getByTestId('zone-target-top').selectOption(targetSlot);
      await page.getByTestId('zone-save-top').click();
      await expect(page.getByTestId('zone-saved-top')).toBeVisible();
      await page.reload();
      await expect(page.getByTestId('orientation-wizard')).toHaveAttribute('data-step', '2');
      await expect(page.getByTestId('zone-target-top')).toHaveValue(targetSlot);
      await page.getByTestId('orientation-review').click();
      await expect(page.getByTestId('viewport-error')).toHaveCount(0);
      await page.getByTestId('orientation-finish').click();
      await expect(page).toHaveURL(/\/admin\/packs$/);
      await expect(page.getByTestId(`pack-${manifest.key}-${manifest.version}`)).toHaveAttribute(
        'data-status',
        'published',
      );
      await page.goto(`/admin/packs/${id}/setup`);
      await expect(
        page.getByText('Create a draft so existing designs keep their current orientation.'),
      ).toBeVisible();
      await page.goto(`/admin/packs/${id}/thumbnails`);
      await page.getByRole('button', { name: 'Generate preview', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Capture preview', exact: true }),
      ).toBeEnabled({ timeout: 60_000 });
      await expect(page.getByTestId('viewport-error')).toHaveCount(0);
    } finally {
      await page.evaluate(async (packId) => {
        await fetch(`/api/admin/packs/${packId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'deprecated' }),
        });
      }, id);
    }
  });
});

test.describe('saved design orientation', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'requires isolated member account');
  test.use({ storageState: STORAGE_STATE });
  test('inspection rotation follows its selected mode without changing the saved lighting preset', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 1400 });
    await page.goto('/catalog');
    await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
    await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
    const url = page.url();
    try {
      await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
      const before = await storedDesign(page);
      const writes: string[] = [];
      page.on('request', (request) => {
        if (
          request.method() === 'PATCH' &&
          request.url().endsWith(new URL(url).pathname.replace('/design/', '/api/designs/'))
        )
          writes.push(request.url());
      });
      await expect(
        page.getByRole('heading', { name: 'Lighting preset', exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId('inspection-rotation')).toHaveValue('0');
      await page.getByTestId('inspect-artwork').click();
      await expect(page.getByTestId('inspection-rotation')).toBeVisible();
      await page.getByTestId('inspection-rotation').fill('75');
      await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('environment')).toHaveValue(
        before.document.scene.environmentKey,
      );
      await page.getByTestId('design-lighting').click();
      await expect(page.getByTestId('inspection-rotation')).toHaveCount(0);
      await page.getByTestId('inspect-artwork').click();
      await expect(page.getByTestId('inspection-rotation')).toHaveValue('75');
      await page.getByTestId('inspection-reset').click();
      await expect(page.getByTestId('inspection-rotation')).toHaveValue('0');
      await page.screenshot({ path: testInfo.outputPath('inspection-controls.png') });
      await page.getByTestId('open-render-settings').click();
      await page.getByRole('button', { name: 'Use design lighting', exact: true }).click();
      await expect(page.getByTestId('design-lighting')).toHaveAttribute('aria-pressed', 'true');
      const after = await storedDesign(page);
      expect(after.document).toEqual(before.document);
      expect(after.version).toBe(before.version);
      expect(writes).toEqual([]);
      await page.reload();
      await expect(page.getByTestId('mode-look')).toHaveText('Viewer');
      await expect(page.getByTestId('mode-look')).toHaveClass('active');
      await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('inspection-rotation')).toHaveValue('0');
      await expect(page.getByTestId('environment')).toHaveValue(
        before.document.scene.environmentKey,
      );
    } finally {
      await page.goto(url);
      await page.evaluate(async () => {
        await fetch(`/api/designs/${location.pathname.split('/').pop()}`, { method: 'DELETE' });
      });
    }
  });
  test('applies an override while preserving artwork and clears it through the same workflow', async ({
    page,
  }) => {
    // Two full wizard passes and a reload; software WebGL on CI needs longer than one test's limit.
    test.slow();
    await page.goto('/catalog');
    await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
    await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
    const url = page.url();
    try {
      await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');
      await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
      await page.getByTestId('mode-look').click();
      await page.getByTestId('camera-top').click();
      await waitForStored(
        page,
        (s) => s.document.scene.camera.presetKey === 'top',
        'Top view was not saved',
      );
      const before = (await storedDesign(page)).document;
      await page.getByTestId('reorient-product').click();
      await waitForOrientationModel(page);
      await page.getByTestId('orientation-view-top').click();
      await page.getByTestId('orientation-current-view').click();
      await page.getByTestId('orientation-confirm').click();
      await page.getByTestId('orientation-review').click();
      await page.getByTestId('orientation-use-front').check();
      await page.getByTestId('orientation-finish').click();
      await expect(page.getByTestId('reorient-product')).toBeVisible();
      const after = (await storedDesign(page)).document;
      expect(after.scene.presentationOrientationOverride?.frontSource[1]).toBeCloseTo(1);
      expect(after.scene.camera.kind).toBe('custom');
      expect(after.scene.camera.positionMm?.[1]).toBeGreaterThan(100);
      expect(after.placements).toEqual(before.placements);
      expect(after.materials).toEqual(before.materials);
      await page.reload();
      await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
      await page.getByTestId('reorient-product').click();
      await page.getByTestId('orientation-use-default').click();
      await page.getByTestId('orientation-confirm').click();
      await page.getByTestId('orientation-review').click();
      await page.getByTestId('orientation-finish').click();
      await expect(page.getByTestId('reorient-product')).toBeVisible();
      const cleared = (await storedDesign(page)).document;
      expect(cleared.scene.presentationOrientationOverride).toBeUndefined();
      expect(cleared.scene.camera).toEqual(after.scene.camera);
    } finally {
      const id = new URL(url).pathname.split('/')[2]!;
      await page.evaluate(async (designId) => {
        await fetch(`/api/designs/${designId}`, { method: 'DELETE' });
      }, id);
    }
  });
});

test.describe('member authorization', () => {
  test.skip(process.env['DEV_TOOLING'] !== 'true', 'requires isolated member account');
  test.use({ storageState: STORAGE_STATE });
  test('rejects direct staff setup writes', async ({ page }) => {
    await page.goto('/designs');
    const status = await page.evaluate(
      async () =>
        (
          await fetch('/api/admin/packs/00000000-0000-4000-8000-000000000000/setup', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision: '0'.repeat(64) }),
          })
        ).status,
    );
    expect(status).toBe(404);
  });
});
