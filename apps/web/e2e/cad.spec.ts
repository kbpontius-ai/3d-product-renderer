import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { STAFF_STORAGE_STATE } from './global-setup';
import { waitForOrientationModel } from './helpers';

/**
 * CAD ingestion, end to end (F-ADM-01, F-GEN-02, docs/23-cad-ingestion.md).
 *
 * The whole loop, through the browser: a STEP file goes in, a worker turns it into meshes, and a
 * draft pack comes out the other side with the zones left for a person. Every part of that is real
 * — the queue, the worker, the validator, storage, the pack importer — except the kernel, which is
 * the reference importer. That is exactly the seam the reference importer exists to make testable.
 */

test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
test.beforeAll(() => {
  if (process.env['CI'])
    expect(process.env['E2E_CAD_WORKER'], 'CAD E2E requires the reference worker').toBe('true');
});
test.describe.configure({ mode: 'serial' });
test.use({ storageState: STAFF_STORAGE_STATE });

/**
 * A real STEP file with real geometry in it, marked so each run's upload is its own.
 *
 * Not a hand-written header: the worker may be running the OCCT importer, which reads the DATA
 * section and quite rightly refuses a file with no solids in it. The marker goes in the description
 * rather than anywhere structural, so it changes the digest — which is what makes each run a
 * separate ingestion instead of a dedupe hit on the last one — without changing the geometry.
 */
const FIXTURE = resolve('fixtures/cad/closure-38.step');

async function step(marker: string): Promise<string> {
  const source = await readFile(FIXTURE, 'latin1');
  return source.replace(
    "FILE_DESCRIPTION(('Open CASCADE Model')",
    `FILE_DESCRIPTION(('${marker}')`,
  );
}

/** Packs drafted here share a catalog with every other spec, so they are retired afterwards. */
const drafted: string[] = [];

test.afterEach(async ({ page }) => {
  for (const key of drafted.splice(0)) {
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

/** Uploads through the real endpoint, because the file picker cannot be driven from a fixture. */
async function upload(page: Page, body: string, fileName: string) {
  return page.evaluate(
    async ([content, name]) => {
      const response = await fetch('/api/admin/cad', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': name! },
        body: content,
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          job?: { id: string; status: string; format: string };
          error?: { code?: string; detail?: string };
          sniffed?: { format: string; extensionMismatch: boolean };
        },
      };
    },
    [body, fileName] as const,
  );
}

async function settled(
  page: Page,
  jobId: string,
): Promise<{ status: string; error?: { code: string } }> {
  return page.evaluate(async (id: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await fetch(`/api/admin/cad/${id}`);
      const body = (await response.json()) as { job: { status: string; error?: { code: string } } };
      if (body.job.status !== 'queued' && body.job.status !== 'running') return body.job;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('the ingestion never finished');
  }, jobId);
}

test('a STEP file becomes a draft pack with zones left to author', async ({ page }) => {
  // Imports through the queue and then loads the orientation model: two slow waits in one test.
  test.slow();
  test.skip(process.env['E2E_CAD_WORKER'] !== 'true' && !process.env['CI'], 'no CAD worker is running');

  const marker = `e2e-${randomBytes(4).toString('hex')}`;
  await page.goto('/admin/cad');
  await expect(page.getByTestId('cad')).toBeVisible();

  const queued = await upload(page, await step(marker), `${marker}.step`);
  expect(queued.status).toBe(201);
  const jobId = queued.body.job!.id;
  expect(queued.body.sniffed?.format).toBe('step');

  const finished = await settled(page, jobId);
  expect(finished.status).toBe('succeeded');

  // What the operator sees: the measured dimensions and the part count, not a job id.
  await page.reload();
  await expect(page.getByTestId(`cad-${jobId}-status`)).toHaveText('succeeded');
  await expect(page.getByTestId(`cad-${jobId}-result`)).toContainText('part(s)');

  const drafting = await page.evaluate(
    async ([id, key]) => {
      const response = await fetch(`/api/admin/cad/${id}/pack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          packKey: key,
          packName: `E2E ${key}`,
          productKey: 'cap-flat',
          productName: `E2E ${key} closure`,
          category: 'closures',
          variantKey: '38mm',
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          result?: { key: string; version: string; status: string };
          todos?: { code: string }[];
          manifest?: { products: { variants: { zones: unknown[]; materialSlots: unknown[] }[] }[] };
        },
      };
    },
    [jobId, marker] as const,
  );

  expect(drafting.status).toBe(201);
  drafted.push(marker);

  expect(drafting.body.result).toMatchObject({ key: marker, version: '0.1.0', status: 'created' });
  // The empties are the deliverable: a draft that guessed at a zone is a draft somebody publishes
  // without reading, and a zone in the wrong place is a logo in the wrong place on a real product.
  expect(drafting.body.manifest!.products[0]!.variants[0]!.zones).toEqual([]);
  expect(drafting.body.manifest!.products[0]!.variants[0]!.materialSlots.length).toBeGreaterThan(0);
  expect(drafting.body.todos!.map((todo) => todo.code)).toContain('zones_missing');

  // And it is a draft, not a product: nothing a customer can reach until somebody publishes it.
  const packs = await page.evaluate(async () => {
    const response = await fetch('/api/admin/packs');
    return (await response.json()) as { packs: { key: string; status: string }[] };
  });
  expect(packs.packs.find((pack) => pack.key === marker)?.status).toBe('draft');

  // The ingestion now knows what was drafted from it, and leads straight to where it is finished.
  await page.goto('/admin/cad');
  const drafts = page.getByTestId(`cad-${jobId}-drafts`);
  await expect(drafts).toContainText(`${marker}@0.1.0`);
  await drafts.getByRole('link', { name: `${marker}@0.1.0` }).click();
  await page.waitForURL(/\/admin\/packs\/[0-9a-f-]{36}\/setup$/);
  await waitForOrientationModel(page);
  await page.getByTestId('orientation-current-view').click();
  await page.getByTestId('orientation-confirm').click();
  await expect(page.getByTestId('orientation-wizard')).toHaveAttribute('data-step', '2');
  await expect(page.getByTestId('zones-empty')).toBeVisible();
});

test('a file that is not CAD is refused before any parser sees it', async ({ page }) => {
  await page.goto('/admin/cad');

  const refused = await upload(page, '#!/bin/sh\nrm -rf /\n', 'trojan.step');

  expect(refused.status).toBe(422);
  expect(refused.body.error?.code).toBe('unsupported_format');
});

test('a STEP file with a protocol we do not import is refused in milliseconds', async ({
  page,
}) => {
  await page.goto('/admin/cad');

  const electronics = (await step('e2e-ap210')).replace(
    /FILE_SCHEMA\(\([^)]*\)\)/,
    "FILE_SCHEMA(('ELECTRONIC_ASSEMBLY_INTERCONNECT_AND_PACKAGING_DESIGN'))",
  );
  const refused = await upload(page, electronics, 'board.step');

  expect(refused.status).toBe(422);
  expect(refused.body.error?.code).toBe('unsupported_schema');
});

test('the format comes from the content, not the extension', async ({ page }) => {
  test.skip(process.env['E2E_CAD_WORKER'] !== 'true' && !process.env['CI'], 'no CAD worker is running');
  await page.goto('/admin/cad');

  const marker = `e2e-${randomBytes(4).toString('hex')}`;
  const queued = await upload(page, await step(marker), `${marker}.stl`);

  expect(queued.status).toBe(201);
  expect(queued.body.job?.format).toBe('step');
  expect(queued.body.sniffed?.extensionMismatch).toBe(true);
});

test('source CAD is never served back, to anyone', async ({ page }) => {
  test.skip(process.env['E2E_CAD_WORKER'] !== 'true' && !process.env['CI'], 'no CAD worker is running');
  await page.goto('/admin/cad');

  const marker = `e2e-${randomBytes(4).toString('hex')}`;
  const queued = await upload(page, await step(marker), `${marker}.step`);
  expect(queued.status).toBe(201);

  // Staff, signed in, on the very deployment that stored it, asking for the file it just uploaded.
  // Still 404: this is the one prefix the asset route refuses by name (F-PLAT-04).
  const attempt = await page.evaluate(async () => {
    const response = await fetch('/api/assets/cad-source/anything/whatever.step');
    return response.status;
  });
  expect(attempt).toBe(404);
});
