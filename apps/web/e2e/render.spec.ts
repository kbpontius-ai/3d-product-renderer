import { expect, test, type Page } from '@playwright/test';
import { uploadArtwork, waitForStored, storedDesign } from './helpers';
import { STORAGE_STATE } from './global-setup';
import type { RenderLighting, RenderSpec } from '@pr/design-schema';

/**
 * Rendering, through the browser (W-08).
 *
 * The payoff of the whole product: a design becomes a photorealistic image the user can download.
 * These drive the real editor and the real queue; a worker has to be running for a job to finish,
 * so the parts that need one are skipped without it.
 */

test.describe.configure({ mode: 'default' });
test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');

const workerRunning = process.env['E2E_RENDER_WORKER'] === 'true';

// One account for the whole suite, provisioned in global setup: accepting an invitation is rate
// limited per IP, and these tests are not about that.
test.use({ storageState: STORAGE_STATE });

let submittedJobs: Promise<{ id: string }>[];
test.beforeEach(({ page }) => {
  submittedJobs = [];
  page.on('response', (response) => {
    if (response.ok() && response.request().method() === 'POST' &&
        /\/api\/designs\/[^/]+\/renders$/.test(response.url())) {
      submittedJobs.push(response.json() as Promise<{ id: string }>);
    }
  });
});
test.afterEach(async ({ page }) => {
  // Submission-only assertions must not leave path traces ahead of the lifecycle tests.
  for (const id of new Set((await Promise.all(submittedJobs)).map((job) => job.id))) {
    const status = await page.evaluate(async (jobId) =>
      (await fetch(`/api/renders/${jobId}`, { method: 'DELETE' })).status, id);
    expect([200, 204, 404]).toContain(status);
  }
});

async function designWithArtwork(page: Page): Promise<void> {
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await uploadArtwork(page, 'fixtures/artwork/samples/wordmark.svg');
}

test('a design with artwork can be submitted for rendering', async ({ page }) => {
  await designWithArtwork(page);

  await page.getByTestId('preset-draft').click();
  await page.getByTestId('render-button').click();

  await expect(page.getByTestId('render-job')).toBeVisible();
  // Queued or already running: either way the job exists and the tray is watching it.
  await expect(page.getByTestId('render-job')).toHaveAttribute('data-status', /queued|running/);
});

test('Render captures Inspection lighting without switching the viewer', async ({ page }) => {
  await designWithArtwork(page);
  await page.getByTestId('inspection-rotation').fill('45');
  await page.route('**/api/designs/*/renders', async (route) => {
    const body = route.request().postDataJSON() as { lighting: RenderLighting };
    expect(body.lighting.environmentKey).toBe('studio-detail-v1');
    expect(body.lighting.orientation?.frontSource[1]).toBeCloseTo(1);
    expect(body.lighting.orientation?.upSource[0]).toBeCloseTo(-Math.SQRT1_2);
    expect(body.lighting.orientation?.upSource[2]).toBeCloseTo(-Math.SQRT1_2);
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_lighting' } }) });
  });
  await page.getByTestId('render-button').click();
  await expect(page.getByTestId('render-error')).toContainText('viewer lighting is invalid');
  await expect(page.getByTestId('inspect-artwork')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('inspection-rotation')).toHaveValue('45');
});

test('queued jobs retain Inspection or Design lighting independently of the saved preset', async ({ page }) => {
  test.skip(!process.env['DATABASE_URL'], 'requires isolated database');
  await designWithArtwork(page);
  const before = await storedDesign(page);
  await page.getByTestId('inspection-rotation').fill('75');
  const { connect, withStaff } = await import('@pr/db');
  const sql = connect({ url: process.env['DATABASE_URL']! });
  try {
    for (const inspection of [true, false]) {
      if (!inspection) await page.getByTestId('design-lighting').click();
      const response = page.waitForResponse((r) => r.url().endsWith('/renders') && r.request().method() === 'POST');
      await page.getByTestId('render-button').click();
      const submitted = await response;
      expect(submitted.ok()).toBe(true);
      const job = await submitted.json() as { id: string };
      const [row] = await withStaff(sql, (tx) => tx`select spec from render_jobs where id = ${job.id}`);
      expect(row).toBeDefined();
      const spec = row!['spec'] as RenderSpec;
      expect(spec.resolved.environment.key).toBe(inspection ? 'studio-detail-v1' : before.document.scene.environmentKey);
      expect(spec.document.scene.environmentKey).toBe(before.document.scene.environmentKey);
      if (inspection) expect(spec.resolved.environment.orientation).toBeDefined();
      expect((await storedDesign(page)).document.scene.environmentKey).toBe(before.document.scene.environmentKey);
      const status = await page.evaluate(async (jobId) =>
        (await fetch(`/api/renders/${jobId}`, { method: 'DELETE' })).status, job.id);
      expect([200, 204]).toContain(status);
    }
  } finally { await sql.end(); }
});

test('unknown lighting is rejected before a render is queued', async ({ page }) => {
  await designWithArtwork(page);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const result = await page.evaluate(async (designId) => {
    const response = await fetch(`/api/designs/${designId}/renders`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lighting: { environmentKey: 'unknown-studio', rotationDeg: 0 } }),
    });
    return { status: response.status, body: await response.json() as { error: { code: string } } };
  }, id);
  expect(result.status).toBe(422);
  expect(result.body.error.code).toBe('invalid_lighting');
});

test('the same design at the same settings does not queue twice', async ({ page }) => {
  await designWithArtwork(page);
  await page.getByTestId('preset-draft').click();

  const submit = async () => {
    const response = await page.evaluate(
      (id: string) =>
        fetch(`/api/designs/${id}/renders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preset: 'draft', size: 'web' }),
        }).then((r) => r.json() as Promise<{ id: string; deduped: boolean }>),
      new URL(page.url()).pathname.split('/').pop()!,
    );
    return response;
  };

  const first = await submit();
  const again = await submit();

  expect(again.id).toBe(first.id);
  expect(again.deduped).toBe(true);
});

test('a custom size is refused when it is larger than the organization may render', async ({ page }) => {
  await designWithArtwork(page);

  await page.getByTestId('size-custom').click();
  await page.getByTestId('size-width').fill('12000');
  await page.getByTestId('render-button').click();

  await expect(page.getByTestId('render-error')).toContainText('larger than this organization');
});

test('the format and the size are the ones asked for', async ({ page }) => {
  await designWithArtwork(page);

  await page.getByTestId('preset-draft').click();
  await page.getByTestId('size-1k').click();
  await page.getByTestId('format-jpeg').click();
  await page.getByTestId('render-button').click();

  await expect(page.getByTestId('render-job')).toBeVisible();
});

test('a design with nothing placed on it cannot be rendered', async ({ page }) => {
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('artwork-sample-hint')).toBeVisible();

  await page.getByTestId('render-button').click();
  await expect(page.getByTestId('render-error')).toContainText('Place your artwork');
});

test('artwork already uploaded can be placed again without uploading it again', async ({ page }) => {
  await designWithArtwork(page);

  // A second design, starting from the library rather than the file picker.
  await page.goto('/catalog');
  await page.getByTestId('start-cap-basic-cap-flat-38mm').click();
  await page.waitForURL(/\/design\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('artwork-sample-hint')).toBeVisible();

  await page.getByTestId('artwork-library-toggle').click();
  // By name, not by position: the library is shared across the organisation, so whatever a
  // colleague uploaded last is not necessarily what this test just made.
  await page.getByTestId('artwork-library').getByRole('button', { name: /wordmark/ }).first().click();

  await expect(page.getByTestId('artwork-name')).toContainText('wordmark');
  await waitForStored(page, (s) => s.document.placements.length > 0, 'the library pick was not placed');
});

test.describe('with a worker running', () => {
  test.beforeAll(() => {
    expect(workerRunning, 'render lifecycle tests require E2E_RENDER_WORKER=true').toBe(true);
  });
  test.skip(!workerRunning && !process.env['CI'], 'no render worker; set E2E_RENDER_WORKER=true');
  // These wait on a path tracer, not on the app: the default thirty seconds measures the machine.
  test.describe.configure({ timeout: 900_000 });

  test('a submitted render finishes and can be downloaded', async ({ page }) => {
    await designWithArtwork(page);
    await page.getByTestId('preset-draft').click();
    await page.getByTestId('render-button').click();

    // A draft render of one cap: a couple of minutes on a CPU, and the tray follows it the whole way.
    await expect(page.getByTestId('render-job')).toHaveAttribute('data-status', 'succeeded', {
      timeout: 600_000,
    });

    const output = page.getByTestId('render-output').first();
    await expect(output).toBeVisible();

    const url = await output.getAttribute('href');
    const status = await page.evaluate((href: string) => fetch(href).then((r) => r.status), url!);
    expect(status).toBe(200);

    // The tile shows a web-sized copy while the link still downloads the original (F-EXP-01). Both
    // have to exist, and the small one has to be smaller — a "variant" the same size as the
    // original is a second copy of the problem it was added to solve.
    const previewUrl = await output.locator('img').getAttribute('src');
    expect(previewUrl).not.toBe(url);
    expect(previewUrl).toContain('.web.png');

    const sizes = await page.evaluate(
      ([full, small]: string[]) =>
        Promise.all(
          [full!, small!].map((href) =>
            fetch(href)
              .then((r) => r.arrayBuffer())
              .then((b) => b.byteLength),
          ),
        ),
      [url!, previewUrl!],
    );
    expect(sizes[1]).toBeLessThan(sizes[0]!);
  });

  test('the bell says so when the render is done', async ({ page }) => {
    await designWithArtwork(page);
    await page.getByTestId('preset-draft').click();
    await page.getByTestId('render-button').click();
    await expect(page.getByTestId('render-job')).toHaveAttribute('data-status', 'succeeded', {
      timeout: 600_000,
    });

    // The notification is written by the worker, so this is also a check that the two processes
    // agree about who asked for the render.
    await page.goto('/designs');
    await expect(page.getByTestId('bell-unread')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('bell').click();
    await expect(page.getByTestId('bell-item-render.succeeded').first()).toBeVisible();

    // Looking at it is reading it: the badge does not survive being opened.
    await page.reload();
    await expect(page.getByTestId('bell-unread')).toHaveCount(0);
  });

  test('a finished render appears in the gallery', async ({ page }) => {
    await designWithArtwork(page);
    await page.getByTestId('preset-draft').click();
    await page.getByTestId('render-button').click();
    await expect(page.getByTestId('render-job')).toHaveAttribute('data-status', 'succeeded', {
      timeout: 600_000,
    });

    await page.goto('/renders');
    const ready = page.getByTestId('renders').locator('[data-status="succeeded"]').first();
    await expect(ready).toBeVisible();
    await expect(ready.locator('img')).toBeVisible();
  });
});

/**
 * Last in the file on purpose (the cases run in declaration order): the limit is per account and the suite
 * shares one, so spending a minute's budget in the middle would refuse whatever ran next.
 */
test('a burst of submissions is refused before it reaches the queue', async ({ page }) => {
  await designWithArtwork(page);
  const id = new URL(page.url()).pathname.split('/').pop()!;

  // Twenty a minute is far more than a person places; a script placing them is what this stops.
  const statuses = await page.evaluate(async (designId: string) => {
    const out: number[] = [];
    for (let i = 0; i < 24; i++) {
      const response = await fetch(`/api/designs/${designId}/renders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset: 'draft', size: '1k', format: 'png8' }),
      });
      out.push(response.status);
    }
    return out;
  }, id);

  expect(statuses).toContain(429);
  // And the ones before the limit were served, rather than everything being refused.
  expect(statuses.filter((status) => status < 400).length).toBeGreaterThan(0);


});
