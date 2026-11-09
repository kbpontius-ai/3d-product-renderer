import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { analyzeArtworkSource, preparationSubpaths } from '@pr/svg';
import { previewArtworkPreparation } from '@pr/raster';
import type { StoredArtwork } from '../lib/editor-data';
import { STORAGE_STATE } from './global-setup';
import { openEditor } from './helpers';

test.skip(process.env['DEV_TOOLING'] !== 'true', 'needs the isolated e2e database');
test.use({ storageState: STORAGE_STATE });
let savedIds: string[];
test.beforeEach(() => {
  savedIds = [];
});
test.afterEach(async ({ page }) => {
  await page.evaluate(async (ids) => {
    await Promise.all(ids.map((id) => fetch(`/api/artworks/${id}`, { method: 'DELETE' })));
  }, savedIds);
});
async function upload(page: Page, fixture: string) {
  await page.goto('/artwork');
  await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
  await page
    .getByTestId('gallery-upload-input')
    .setInputFiles(`fixtures/artwork/preparation/${fixture}.svg`);
  await expect(page.getByTestId('preparation-keep-all')).toBeVisible();
}
async function save(page: Page) {
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
  await page.getByTestId('preparation-next').click();
  if (!(await page.getByTestId('preparation-save').isVisible())) {
    for (const checkbox of await page.locator('.preparation-objects input[type=checkbox]').all())
      await checkbox.check();
    await page.getByTestId('preparation-next').click();
  }
  await page.getByTestId('preparation-name').fill(`Synthetic ${randomUUID()}`);
  await expect(page.getByTestId('preparation-save')).toBeEnabled();
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artworks/preparation') && response.request().method() === 'PUT',
  );
  await page.getByTestId('preparation-save').click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  const artwork = (await result.json()) as StoredArtwork;
  savedIds.push(artwork.ref.artworkId);
  await expect(page.getByTestId('artwork-preparation')).toHaveCount(0);
  return artwork;
}

test('starts empty, preserves counters and retains the original privately for re-selection', async ({
  page,
}) => {
  await upload(page, 'monogram');
  await expect(page.getByTestId('preparation-next')).toBeDisabled();
  await page.getByTestId('keep-o1').check();
  await page.getByTestId('keep-o3').check();
  const artwork = await save(page);
  expect(artwork.selectionEditable).toBe(true);
  const original = await page.evaluate(async (ref) => {
    const response = await fetch(
      `/api/artworks/${ref.artworkId}/original?versionId=${ref.versionId}`,
    );
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      nosniff: response.headers.get('x-content-type-options'),
      source: await response.text(),
    };
  }, artwork.ref);
  expect(original.status).toBe(200);
  expect(original.type).toContain('application/octet-stream');
  expect(original.disposition).toContain('attachment');
  expect(original.nosniff).toBe('nosniff');
  expect(original.source).toBe(await readFile('fixtures/artwork/preparation/monogram.svg', 'utf8'));

  const coverage = await page.evaluate(async (record) => {
    const image = async (src: string) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image;
    };
    const [svg, mask] = await Promise.all([image(record.sourceUrl), image(record.maskUrl)]);
    const canvas = document.createElement('canvas');
    canvas.width = record.widthPx;
    canvas.height = record.heightPx;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(mask, 0, 0);
    const stored = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      svg,
      8,
      8,
      record.naturalSizeMm.w / record.mmPerPx,
      record.naturalSizeMm.h / record.mmPerPx,
    );
    const shown = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let difference = 0;
    for (let i = 0; i < stored.length; i += 4) difference += Math.abs(stored[i]! - shown[i + 3]!);
    const x = Math.round(5 / record.mmPerPx) + 8,
      y = Math.round(6 / record.mmPerPx) + 8;
    const privateUrl = record.sourceUrl
      .replace('/artwork/', '/artwork-source/')
      .replace('sanitized.svg', 'original.bin');
    return {
      mae: difference / (stored.length / 4) / 255,
      hole: stored[(y * canvas.width + x) * 4],
      privateStatus: (await fetch(privateUrl)).status,
    };
  }, artwork);
  expect(coverage.mae).toBeLessThan(0.002);
  expect(coverage.hole).toBe(0);
  expect(coverage.privateStatus).toBe(404);
  await page
    .getByTestId(`artwork-tile-${artwork.ref.artworkId}`)
    .getByRole('button')
    .first()
    .click();
  await page.getByTestId('artwork-edit-selection').click();
  await expect(page.getByTestId('keep-o1')).toBeChecked();
  await expect(page.getByTestId('keep-o3')).toBeChecked();
  await expect(page.getByTestId('keep-o0')).not.toBeChecked();
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
});

test('repair starts in Inspect, freezes inclusion, previews closure and requires explicit acceptance and Apply', async ({
  page,
}) => {
  await upload(page, 'open-paths');
  await page.getByTestId('keep-o1').check();
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
  await page.getByTestId('preparation-repair').click();
  await expect(page.getByTestId('artwork-preparation')).toHaveAttribute('data-mode', 'repair');
  await expect(page.getByTestId('preparation-preview-close')).toHaveCount(0);
  await expect(page.getByTestId('preparation-apply-repair')).toHaveCount(0);
  await expect(page.getByTestId('preparation-keep-all')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close loop', exact: true }).click();
  await page.getByTestId('preparation-preview-close').click();
  await expect(page.getByTestId('preparation-apply-repair')).toBeDisabled();
  await expect(page.getByText('After', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to selection', exact: true }).click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await page
    .getByLabel('I reviewed the painted changes, including crossings, counters and joins.')
    .check();
  await page.getByTestId('preparation-apply-repair').click();
  await expect(page.getByTestId('preparation-apply-repair')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Review fill boundary', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Back to selection', exact: true }).click();
  const artwork = await save(page);
  const body = await page.evaluate(async (ref) => {
    const response = await fetch('/api/artworks/preparation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artworkId: ref.artworkId, versionId: ref.versionId }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, artwork.ref);
  expect(body.recipe.repairs).toEqual([{ kind: 'close', objectId: 'o1', subpathId: 'o1:s0' }]);
  expect(preparationSubpaths(body.analysis.objects[1])[0]!.closed).toBe(false);
});

test('a repair that fills a counter highlights paint changes and requires explicit review', async ({
  page,
}) => {
  await page.goto('/artwork');
  await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
  await page.getByTestId('gallery-upload-input').setInputFiles({
    name: 'synthetic-ring.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="30mm" viewBox="0 0 40 30"><path fill="none" stroke="black" stroke-width="2" d="M5 5H15V15H5Z"/></svg>',
    ),
  });
  await page.getByTestId('keep-o0').check();
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
  await page.getByTestId('preparation-repair').click();
  await page.getByRole('button', { name: 'Set stroke width', exact: true }).click();
  await page.getByLabel('Stroke width (mm)', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Preview stroke width', exact: true }).click();
  await expect(page.getByAltText('Highlighted repair changes')).toBeVisible();
  await expect(page.getByText(/changes transparent counters \(1 before, 0 after\)/)).toBeVisible();
  await expect(page.getByTestId('preparation-apply-repair')).toBeDisabled();
  await page
    .getByLabel('I reviewed the painted changes, including crossings, counters and joins.')
    .check();
  await page.getByTestId('preparation-apply-repair').click();
  await page.getByRole('button', { name: 'Back to selection', exact: true }).click();
  const artwork = await save(page);
  expect(artwork.ref.versionId).toBeTruthy();
});

test('retains a usable open stroke without forcing closure and saves no draft on cancel', async ({
  page,
}) => {
  await page.goto('/artwork');
  const name = `cancel-${randomUUID()}`;
  const source = await readFile('fixtures/artwork/preparation/open-paths.svg', 'utf8');
  await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
  await page
    .getByTestId('gallery-upload-input')
    .setInputFiles({ name: `${name}.svg`, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await expect(page.getByTestId('preparation-keep-all')).toBeVisible();
  await page.getByTestId('keep-o0').check();
  await page.getByTestId('preparation-repair').click();
  await expect(page.getByText('Usable open stroke', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep open', exact: true }).click();
  await page.getByRole('button', { name: 'Back to selection', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('confirm-accept').click();
  const after = await page.evaluate(async () =>
    fetch('/api/artworks').then((response) => response.json()),
  );
  expect(after.artworks.some((item: StoredArtwork) => item.name === name)).toBe(false);
});

test('stale responses cannot enable confirmation after the selection is cleared', async ({
  page,
}) => {
  await upload(page, 'monogram');
  await page.route('**/api/artworks/preparation', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response });
  });
  await page.getByTestId('keep-o1').check();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByTestId('preparation-next')).toBeDisabled();
  await expect(page.getByTestId('preparation-updating')).toHaveCount(0);
  await expect(page.getByTestId('preparation-next')).toBeDisabled();
  await expect(page.getByTestId('preparation-result')).toContainText('Click the parts');
});

test('unsupported paint effects show a recovery hint instead of an altered SVG', async ({
  page,
}) => {
  await page.goto('/artwork');
  await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
  await page
    .getByTestId('gallery-upload-input')
    .setInputFiles('fixtures/artwork/preparation/unsupported-effects.svg');
  await expect(page.getByTestId('preparation-error')).toContainText(/gradient|opacity/);
  await expect(page.getByTestId('preparation-error')).toContainText(/Export|export/);
  await expect(page.getByTestId('preparation-source')).toHaveCount(0);
  await expect(page.getByTestId('preparation-save')).toHaveCount(0);
});

test('canvas picking resolves paint order and exposes an explicit overlap chooser', async ({
  page,
}) => {
  await upload(page, 'monogram');
  await page.getByTestId('preparation-source').scrollIntoViewIfNeeded();
  const point = await page.getByTestId('preparation-source').evaluate((svg) => {
    const matrix = (svg as unknown as SVGSVGElement).getScreenCTM()!;
    const point = new DOMPoint(11, 12).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('keep-o2')).toBeChecked();
  await expect(page.getByTestId('keep-o1')).not.toBeChecked();
  await page.keyboard.down('Alt');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Alt');
  await expect(page.getByText('Choose object here · front to back')).toBeVisible();
  await page
    .locator('.preparation-candidates')
    .getByRole('button', { name: 'outer-letter', exact: true })
    .click();
  await expect(page.getByTestId('keep-o1')).toBeChecked();
});

test('chooses coincident endpoints explicitly and lets an unpainted path acquire a previewed width', async ({
  page,
}) => {
  await upload(page, 'ambiguous-and-empty');
  await page.getByTestId('keep-o0').check();
  await page.getByTestId('keep-o1').check();
  await page.getByTestId('keep-o2').check();
  await page.getByTestId('preparation-repair').click();
  await page.getByRole('button', { name: 'Join ends', exact: true }).click();
  await page.getByTestId('preparation-source').scrollIntoViewIfNeeded();
  const point = await page.getByTestId('preparation-source').evaluate((svg) => {
    const point = new DOMPoint(10, 4).matrixTransform(
      (svg as unknown as SVGSVGElement).getScreenCTM()!,
    );
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByText('Choose endpoint at this position')).toBeVisible();
  await expect(page.locator('.preparation-candidates').getByRole('button')).toHaveCount(3);
  await page.getByRole('button', { name: 'Back to selection', exact: true }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByTestId('keep-o3').check();
  await expect(page.getByTestId('preparation-next')).toBeDisabled();
  await page.getByTestId('preparation-repair').click();
  await page.getByRole('button', { name: 'Set stroke width', exact: true }).click();
  await page.getByRole('button', { name: 'Preview stroke width', exact: true }).click();
  await expect(page.getByText('After', { exact: true })).toBeVisible();
  await page
    .getByLabel('I reviewed the painted changes, including crossings, counters and joins.')
    .check();
  await page.getByTestId('preparation-apply-repair').click();
  await page.getByRole('button', { name: 'Back to selection', exact: true }).click();
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
});

test('the API rejects forged derived content, malformed UTF-8 and oversized streaming requests', async ({
  page,
}) => {
  await page.goto('/artwork');
  const statuses = await page.evaluate(async () => {
    const post = async (body: BodyInit) =>
      fetch('/api/artworks/preparation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }).then((response) => response.status);
    return [
      await post(JSON.stringify({ source: '<svg/>', svg: '<svg><script/></svg>' })),
      await post(new Uint8Array([255])),
      await post(' '.repeat(8 * 1024 * 1024 + 1)),
    ];
  });
  expect(statuses).toEqual([422, 422, 413]);
});

for (const [name, ids, white] of [
  ['occluded-rim', ['o0'], true],
  ['open-paths', ['o0'], false],
  ['compound-and-reuse', ['o2'], false],
  ['styled-strokes', ['o0', 'o1', 'o2', 'o3'], false],
] as const) {
  test(`browser conformance of source and prepared geometry: ${name}`, async ({ page }) => {
    await openEditor(page);
    const original = await readFile(`fixtures/artwork/preparation/${name}.svg`, 'utf8');
    const analysis = await analyzeArtworkSource(original);
    const result = previewArtworkPreparation(analysis, {
      sourceDigest: analysis.sourceDigest,
      analyzerVersion: analysis.analyzerVersion,
      selected: ids.map((objectId) => ({ objectId, paint: 'both' })),
      repairs: [],
      acknowledged: [],
      transforms: [],
    });
    expect(result.canSave).toBe(true);
    for (const side of [256, 1024]) {
      const diff = await page.evaluate(
        async ({ original, safe, output, box, view, ids, white, side }) => {
          const height = Math.round((side * view.h) / view.w);
          const render = async (
            source: string,
            placement?: { x: number; y: number; w: number; h: number },
          ) => {
            const image = new Image();
            image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            // Stroke and polygon antialiasers differ at coarse pixel edges; compare coverage.
            const samples = 4;
            canvas.width = side * samples;
            canvas.height = height * samples;
            const ctx = canvas.getContext('2d')!;
            ctx.scale(samples, samples);
            if (placement)
              ctx.drawImage(
                image,
                (placement.x * side) / view.w,
                (placement.y * side) / view.w,
                (placement.w * side) / view.w,
                (placement.h * side) / view.w,
              );
            else ctx.drawImage(image, 0, 0, side, height);
            const coverage = document.createElement('canvas');
            coverage.width = side;
            coverage.height = height;
            const pixels = coverage.getContext('2d')!;
            pixels.imageSmoothingQuality = 'high';
            pixels.drawImage(canvas, 0, 0, side, height);
            return pixels.getImageData(0, 0, side, height).data;
          };
          const originalPixels = await render(original),
            safePixels = await render(safe);
          let sourceDiff = 0;
          for (let i = 0; i < safePixels.length; i++)
            sourceDiff += Math.abs(safePixels[i]! - originalPixels[i]!);
          const dom = new DOMParser().parseFromString(safe, 'image/svg+xml');
          if (!white)
            for (const shape of dom.querySelectorAll('[data-preparation-id]'))
              if (!ids.includes(shape.getAttribute('data-preparation-id')!)) shape.remove();
          const reference = await render(new XMLSerializer().serializeToString(dom));
          const prepared = await render(output, box);
          const shifted = await render(output, { ...box, x: box.x + 1 });
          let maskDiff = 0;
          let shiftedDiff = 0;
          for (let i = 0; i < reference.length; i += 4) {
            const ref = white ? (reference[i]! * reference[i + 3]!) / 255 : reference[i + 3]!;
            maskDiff += Math.abs(ref - prepared[i + 3]!);
            shiftedDiff += Math.abs(ref - shifted[i + 3]!);
          }
          return {
            sourceMae: sourceDiff / safePixels.length / 255,
            markMae: maskDiff / (reference.length / 4) / 255,
            shiftedMae: shiftedDiff / (reference.length / 4) / 255,
          };
        },
        {
          original,
          safe: analysis.sourceSvg,
          output: result.svg!,
          box: result.keptBoundsMm!,
          view: analysis.viewBox,
          ids: [...ids] as string[],
          white,
          side,
        },
      );
      expect(diff.sourceMae).toBeLessThan(0.002);
      expect(diff.markMae).toBeLessThan(0.002);
      expect(diff.shiftedMae).toBeGreaterThan(0.002);
    }
  });
}

test('color shortcuts preview candidates and mobile users can collapse the object list', async ({
  page,
}) => {
  await upload(page, 'monogram');
  await page
    .locator('.preparation-object')
    .filter({ hasText: 'outer-letter' })
    .getByRole('button')
    .click();
  await page.getByRole('button', { name: 'Select similar color #ffffff', exact: true }).click();
  await expect(page.getByText('1 matching objects:', { exact: false })).toBeVisible();
  await page.getByLabel('Include similar shades').fill('3');
  await expect(page.getByText('2 matching objects:', { exact: false })).toBeVisible();
  await expect(
    page.getByTestId('preparation-source').locator('path[stroke="#885ca2"]'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Apply color selection', exact: true }).click();
  await expect(page.getByTestId('keep-o1')).toBeChecked();
  await expect(page.getByTestId('keep-o3')).toBeChecked();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('keep-o1')).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Hide objects', exact: true }).click();
  await expect(page.locator('.preparation-objects')).not.toBeVisible();
  await page.getByRole('button', { name: 'Prepared', exact: true }).click();
  await expect(page.getByTestId('preparation-result')).toBeVisible();
  await expect(page.getByTestId('preparation-source')).not.toBeVisible();
  await page.getByRole('button', { name: 'Show objects', exact: true }).click();
  await expect(page.locator('.preparation-objects')).toBeVisible();
});

test('a concurrent version update keeps the unsaved recipe available for saving a separate artwork', async ({
  page,
}) => {
  await page.goto('/artwork');
  await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
  const source = await readFile('fixtures/artwork/preparation/monogram.svg', 'utf8');
  // Source identity isolates this version race from other tests sharing the same organization.
  await page.getByTestId('gallery-upload-input').setInputFiles({
    name: 'monogram.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(`<!-- ${randomUUID()} -->\n${source}`),
  });
  await expect(page.getByTestId('preparation-keep-all')).toBeVisible();
  await page.getByTestId('keep-o1').check();
  const original = await save(page);
  await page
    .getByTestId(`artwork-tile-${original.ref.artworkId}`)
    .getByRole('button')
    .first()
    .click();
  await page.getByTestId('artwork-edit-selection').click();
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
  await page.getByTestId('keep-o3').check();
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
  await page.getByTestId('preparation-next').click();
  await expect(page.getByTestId('preparation-save')).toBeEnabled();
  const status = await page.evaluate(
    async (artwork) =>
      fetch(`/api/artworks/${artwork.ref.artworkId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          versionId: artwork.ref.versionId,
          name: artwork.name,
          widthMm: 40,
          heightMm: 40,
          rotationDeg: 0,
          flipX: false,
          flipY: false,
        }),
      }).then((response) => response.status),
    original,
  );
  expect(status).toBe(200);
  await page.getByTestId('preparation-save').click();
  await expect(page.getByTestId('preparation-error')).toContainText(/changed|version/i);
  await expect(page.getByTestId('keep-o3')).toHaveCount(0);
  const copied = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artworks/preparation') && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save as separate artwork', exact: true }).click();
  const response = await copied;
  expect(response.ok(), await response.text()).toBe(true);
  const copy = (await response.json()) as StoredArtwork;
  savedIds.push(copy.ref.artworkId);
  expect(copy.ref.artworkId).not.toBe(original.ref.artworkId);
  expect(copy.naturalSizeMm).toEqual({ w: 30, h: 20 });
  await expect(page.getByTestId('artwork-preparation')).toHaveCount(0);
});

for (const [body, hint] of [
  ['<text>Sample</text>', 'Convert text to outlines'],
  ['<image href="data:image/png;base64,AA=="/>', 'Trace it into vector shapes'],
  ['<rect width="10" height="10" style="filter:blur(1px)"/>', 'filter'],
  ['<style>rect:hover{fill:red}</style><rect width="10" height="10"/>', 'selector'],
  [`<rect class="${'x'.repeat(4097)}" width="5" height="5"/>`, 'attribute'],
  ['<rect width="5" height="5" style="fill-rule:revert"/>', 'rollback'],
] as const) {
  test(`unsupported feature is explained in the upload workflow: ${hint}`, async ({ page }) => {
    await page.goto('/artwork');
    await page.locator('[data-testid=artwork-page][data-hydrated=true]').waitFor();
    await page.getByTestId('gallery-upload-input').setInputFiles({
      name: 'unsupported.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">${body}</svg>`,
      ),
    });
    await expect(page.getByTestId('preparation-error')).toContainText(hint);
    await expect(page.getByTestId('preparation-error')).toContainText(
      /Export|export|Simplify|source editor|vector editor/,
    );
    await expect(page.getByTestId('preparation-save')).toHaveCount(0);
  });
}

test('duplicate preparation of an older version returns an understandable recovery error', async ({
  page,
}) => {
  await page.goto('/artwork');
  const original = await readFile('fixtures/artwork/preparation/monogram.svg', 'utf8');
  const source = `<!-- ${randomUUID()} -->\n${original}`;
  const result = await page.evaluate(async (source) => {
    const json = async (url: string, method: string, body: unknown) => {
      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const analyzed = await json('/api/artworks/preparation', 'POST', { source });
    const recipe = { ...analyzed.body.recipe, selected: [{ objectId: 'o1', paint: 'both' }] };
    const first = await json('/api/artworks/preparation', 'PUT', {
      source,
      recipe,
      name: 'Synthetic cached version',
    });
    const second = await json(`/api/artworks/${first.body.ref.artworkId}`, 'PUT', {
      versionId: first.body.ref.versionId,
      name: first.body.name,
      widthMm: 40,
      heightMm: 40,
      rotationDeg: 0,
      flipX: false,
      flipY: false,
    });
    const retry = await json('/api/artworks/preparation', 'PUT', {
      source,
      recipe,
      name: 'Retry old preparation',
    });
    return { first: first.body as StoredArtwork, second: second.status, retry };
  }, source);
  savedIds.push(result.first.ref.artworkId);
  expect(result.second).toBe(200);
  expect(result.retry.status).toBe(409);
  expect(result.retry.body.error.detail).toMatch(/older version.*Edit selection/);
});
