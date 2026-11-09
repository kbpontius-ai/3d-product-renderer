import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { makeZip } from '@pr/packfile';
import { STAFF_STORAGE_STATE } from './global-setup';

/**
 * Pack ingestion through the browser (F-ADM-01, F-GEN-02).
 *
 * The archive is built here from the real fixture pack, so this exercises the actual format an
 * operator would upload rather than a fixture that could drift away from it.
 */

test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
test.describe.configure({ mode: 'serial' });
test.use({ storageState: STAFF_STORAGE_STATE });

const DIR = 'fixtures/packs/cap-basic';

/**
 * Packs installed by this file are retired afterwards.
 *
 * They share a catalog with every other spec, and a published fixture that outlives its test turns
 * up as a second "Flat-top closure" in someone else's product list.
 */
const installed: string[] = [];

test.afterEach(async ({ page }) => {
  for (const key of installed.splice(0)) {
    await page.evaluate(async (packKey: string) => {
      const response = await fetch('/api/admin/packs');
      const body = (await response.json()) as { packs: { id: string; key: string }[] };
      const pack = body.packs.find((candidate) => candidate.key === packKey);
      if (!pack) return;
      await fetch(`/api/admin/packs/${pack.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'deprecated' }),
      });
    }, key);
  }
});

/** The fixture pack, renamed so each run installs its own and nothing collides. */
async function packArchive(
  options: { omitAsset?: boolean } = {},
): Promise<{ key: string; zip: Buffer }> {
  const manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf8')) as {
    key: string;
    name: string;
    products: { name: string; variants: { assets: Record<string, { path: string }> }[] }[];
  };

  const key = `e2e-${randomBytes(4).toString('hex')}`;
  manifest.key = key;
  manifest.name = `E2E ${key}`;
  // The catalog lists products, not packs, so the product carries the marker this test looks for.
  for (const product of manifest.products) product.name = `E2E ${key} closure`;

  const paths = manifest.products.flatMap((product) =>
    product.variants.flatMap((variant) => Object.values(variant.assets).map((asset) => asset.path)),
  );
  const files = [
    { path: 'manifest.json', bytes: new Uint8Array(Buffer.from(JSON.stringify(manifest), 'utf8')) },
    ...(await Promise.all(
      (options.omitAsset ? paths.slice(1) : paths).map(async (path) => ({
        path,
        bytes: new Uint8Array(await readFile(`${DIR}/${path}`)),
      })),
    )),
  ];

  installed.push(key);
  return { key, zip: Buffer.from(makeZip(files)) };
}

test('a pack is inspected before anything is written, then imported and published', async ({
  page,
}) => {
  const { key, zip } = await packArchive();
  await page.goto('/admin/packs');

  await page
    .getByTestId('pack-file')
    .setInputFiles({ name: `${key}.zip`, mimeType: 'application/zip', buffer: zip });

  const preview = page.getByTestId('pack-preview');
  await expect(preview).toContainText(key);
  await expect(preview).toContainText('1 product(s)');
  await expect(page.getByTestId('pack-missing')).toHaveCount(0);

  // Nothing is in the catalog yet: looking is not importing.
  await expect(page.getByTestId(`pack-${key}-1.0.0`)).toHaveCount(0);

  await page.getByTestId('pack-import-publish').click();
  await expect(page.getByTestId('pack-done')).toContainText(key);
  await expect(page.getByTestId(`pack-${key}-1.0.0`)).toHaveAttribute('data-status', 'published');
});

test('a published pack reaches the catalog, and deprecating takes it back out', async ({
  page,
}) => {
  const { key, zip } = await packArchive();
  await page.goto('/admin/packs');
  await page
    .getByTestId('pack-file')
    .setInputFiles({ name: `${key}.zip`, mimeType: 'application/zip', buffer: zip });
  await page.getByTestId('pack-import-publish').click();
  await expect(page.getByTestId(`pack-${key}-1.0.0`)).toBeVisible();

  await page.goto('/catalog');
  await expect(page.getByText(`E2E ${key} closure`)).toBeVisible();

  await page.goto('/admin/packs');
  await page.getByTestId(`deprecate-${key}`).click();
  await expect(page.getByTestId('confirm-consequences')).toContainText('leaves the catalog');
  await page.getByTestId('confirm-accept').click();
  await expect(page.getByTestId(`pack-${key}-1.0.0`)).toHaveAttribute('data-status', 'deprecated');

  await page.goto('/catalog');
  await expect(page.getByText(`E2E ${key} closure`)).toHaveCount(0);
});

test('a pack missing a file it declares cannot be imported', async ({ page }) => {
  const { zip } = await packArchive({ omitAsset: true });
  await page.goto('/admin/packs');

  await page
    .getByTestId('pack-file')
    .setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: zip });

  await expect(page.getByTestId('pack-missing')).toBeVisible();
  await expect(page.getByTestId('pack-import-publish')).toBeDisabled();
  await expect(page.getByTestId('pack-import-draft')).toBeDisabled();
});

test('something that is not a pack is refused with a reason', async ({ page }) => {
  await page.goto('/admin/packs');

  await page.getByTestId('pack-file').setInputFiles({
    name: 'notes.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('this is not a zip at all', 'utf8'),
  });

  await expect(page.getByTestId('pack-error')).toContainText('not a zip');
});

test('a zone can be adjusted, and the change is refused when it would break the pack', async ({
  page,
}) => {
  const { key, zip } = await packArchive();
  await page.goto('/admin/packs');
  await page
    .getByTestId('pack-file')
    .setInputFiles({ name: `${key}.zip`, mimeType: 'application/zip', buffer: zip });
  await page.getByTestId('pack-import-publish').click();
  await expect(page.getByTestId(`pack-${key}-1.0.0`)).toBeVisible();

  await page.getByTestId(`zones-${key}`).click();
  await page.waitForURL(/\/admin\/packs\/[0-9a-f-]{36}\/zones$/);
  await expect(page.getByTestId('zones')).toBeVisible();

  // The cap fixture's top zone: widen its safe margin and watch it stick.
  await page.getByTestId('zone-margin-top').fill('2.5');
  await page.getByTestId('zone-save-top').click();
  await expect(page.getByTestId('zone-saved-top')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('zone-margin-top')).toHaveValue('2.5');

  // A margin that swallows the zone leaves nothing to print on, and is refused with the reason.
  await page.getByTestId('zone-margin-top').fill('999');
  await page.getByTestId('zone-save-top').click();
  await expect(page.getByTestId('zone-error-top')).toContainText('margin');
});

test('the test pattern opens a real design on the real zone', async ({ page }) => {
  const { key, zip } = await packArchive();
  await page.goto('/admin/packs');
  await page
    .getByTestId('pack-file')
    .setInputFiles({ name: `${key}.zip`, mimeType: 'application/zip', buffer: zip });
  await page.getByTestId('pack-import-publish').click();
  await page.getByTestId(`zones-${key}`).click();

  await page.locator('[data-testid=zone-check-top][data-hydrated]').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  // The editor opened on a design that already has the pattern placed.
  await expect(page.getByTestId('artwork-name')).toContainText('Zone check');
});

test('zones are added, moved and removed on a draft version, never on the published one', async ({
  page,
}) => {
  // The fixture the suite already publishes, rather than another upload: uploads are rate-limited,
  // and this file's other tests use the whole allowance.
  await page.goto('/admin/packs');
  const publishedId = await page.evaluate(async () => {
    const response = await fetch('/api/admin/packs');
    const body = (await response.json()) as {
      packs: { id: string; key: string; version: string }[];
    };
    return body.packs.find((pack) => pack.key === 'cap-basic' && pack.version === '1.0.0')!.id;
  });
  const publishedUrl = `/admin/packs/${publishedId}/zones`;
  await page.goto(publishedUrl);

  // Published: placement is shown but fixed, and the way forward is a draft version — the one
  // already in progress if there is one (a rerun against the same database finds it), else a new one.
  await expect(page.getByTestId('zones-published')).toBeVisible();
  await expect(page.getByTestId('zone-origin-top-x')).toBeDisabled();
  await expect(page.getByTestId('add-zone')).toHaveCount(0);

  const existing = page.getByTestId('open-draft-version');
  await ((await existing.count())
    ? existing
    : page.locator('[data-testid=new-draft-version][data-hydrated]')
  ).click();
  await page.waitForURL(
    (url) => !url.pathname.includes(publishedId) && url.pathname.endsWith('/zones'),
  );
  await expect(page.getByTestId('zones')).toContainText(/cap-basic@1\.\d+\.0/);
  await expect(page.getByTestId('zone-origin-top-x')).toBeEnabled();
  // Every zone is named on the part, and the part can be squared up to an axis.
  await expect(page.getByTestId('zone-label-top')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('zone-view-posZ')).toBeVisible();

  // Move the top zone. Until it is saved the form says so, and leaving asks first.
  const x = page.getByTestId('zone-origin-top-x');
  const moved = (await x.inputValue()) === '4' ? '5' : '4';
  await x.fill(moved);
  await expect(page.getByTestId('zone-unsaved-top')).toBeVisible();
  await page.getByRole('link', { name: 'All packs' }).click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Leave without saving?');
  await page.getByTestId('confirm-cancel').click();
  await expect(page).toHaveURL(/\/zones$/);
  await expect(x).toHaveValue(moved);

  await page.getByTestId('zone-save-top').click();
  await expect(page.getByTestId('zone-saved-top')).toBeVisible();
  await expect(page.getByTestId('zone-unsaved-top')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('zone-origin-top-x')).toHaveValue(moved);

  // Add one. Nothing is filled in for the author, so an empty form is refused field by field.
  const suffix = Math.random().toString(36).slice(2, 7);
  await page.getByTestId('add-zone').click();
  await expect(page.getByTestId('zone-mapping-new')).toHaveValue('conformal');
  await expect(page.getByTestId('zone-mapping-new').locator('option')).toHaveText([
    'Flat surface',
    'Follow surface',
  ]);
  await page.getByTestId('zone-mapping-new').selectOption('planar');
  await expect(page.getByTestId('zone-origin-new-x')).toHaveValue('');
  await page.getByTestId('zone-save-new').click();
  await expect(page.getByTestId('zone-problems-new')).toContainText('Name is empty');

  await page.getByTestId('zone-name-new').fill(`Logo ${suffix}`);
  await page.getByTestId('zone-origin-new-x').fill('0');
  await page.getByTestId('zone-origin-new-y').fill('18');
  await page.getByTestId('zone-origin-new-z').fill('0');
  await page.getByTestId('zone-normal-new-posY').click();
  await page.getByTestId('zone-tangent-new-posX').click();
  await page.getByTestId('zone-width-new').fill('10');
  await page.getByTestId('zone-heightmm-new').fill('8');
  // Measured against the actual mesh: the cap's top face is at y = 18, and every corner is on it.
  await expect(page.getByTestId('zone-distance-new')).toContainText('On the surface', {
    timeout: 20_000,
  });
  // Turned to face into the part, it is on the surface still — and says it faces the wrong way.
  await page.getByTestId('zone-flip-new').click();
  await expect(page.getByTestId('zone-distance-new')).toContainText('faces into the part');
  await page.getByTestId('zone-flip-new').click();

  const key = `logo-${suffix}`;
  await page.getByTestId('zone-save-new').click();
  await expect(page.getByTestId(`zone-${key}`)).toBeVisible();

  // And remove it again.
  await page.getByTestId(`zone-remove-${key}`).click();
  await expect(page.getByRole('dialog')).toContainText(`Remove the zone “Logo ${suffix}”?`);
  const removed = page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.url().includes('/zones?'),
  );
  await page.getByTestId('confirm-accept').click();
  const response = await removed;
  expect(response.status()).toBe(204);
  await expect(page.getByTestId(`zone-${key}`)).toHaveCount(0);

  // The published version was never touched, and now points at the draft instead of starting another.
  await page.goto(publishedUrl);
  await expect(page.getByTestId('zone-origin-top-x')).toHaveValue('0');
  await expect(page.getByTestId('open-draft-version')).toBeVisible();
  await expect(page.getByTestId('new-draft-version')).toHaveCount(0);
});

test('mapping changes persist on drafts and remain locked on published zones', async ({ page }) => {
  await page.goto('/admin/packs');
  const publishedRow = page.getByTestId('pack-bottle-oval-1.0.0');
  await publishedRow.getByTestId('zones-bottle-oval').click();
  const publishedUrl = page.url();
  await expect(page.getByTestId('zone-mapping-flank')).toBeDisabled();
  const existing = page.getByTestId('open-draft-version');
  await ((await existing.count())
    ? existing
    : page.locator('[data-testid=new-draft-version][data-hydrated]')
  ).click();
  const mapping = page.getByTestId('zone-mapping-flank');
  await expect(mapping).toBeEnabled();
  await mapping.selectOption('planar');
  await page.getByTestId('zone-save-flank').click();
  await expect(page.getByTestId('zone-saved-flank')).toBeVisible();
  await page.reload();
  await expect(mapping).toHaveValue('planar');
  await mapping.selectOption('conformal');
  await page.getByTestId('zone-projection-flank').fill('12');
  await page.getByTestId('zone-save-flank').click();
  await expect(page.getByTestId('zone-saved-flank')).toBeVisible();
  await page.reload();
  await expect(mapping).toHaveValue('conformal');
  await expect(page.getByTestId('zone-label-flank')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Designs', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible();
  await page.goto(publishedUrl);
  await expect(mapping).toBeDisabled();
  await expect(page.getByTestId('add-zone')).toHaveCount(0);
});
