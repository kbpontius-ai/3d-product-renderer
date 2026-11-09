import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Sql } from '@pr/db';
import { STAFF_STORAGE_STATE } from './global-setup';

/**
 * The System Status page and the queue's safety rails (F-ADM-15, F-ADM-07, audit 1.5 and section 6).
 *
 * The state is staged straight into the suite's database: a worker that died holding a render, a
 * render that succeeded and one that failed, and two server log lines. Waiting for a real worker to
 * die, or a real server error to happen, would test the calendar rather than the page.
 */

test.skip(process.env['DEV_TOOLING'] !== 'true', 'development tooling is disabled');
test.skip(!process.env['DATABASE_URL'], 'needs the database');

const tag = randomUUID().slice(0, 8);
const ghost = `e2e-ghost-${tag}`;
const ids = { running: randomUUID(), succeeded: randomUUID(), failed: randomUUID() };
const messages = { error: `e2e status error ${tag}`, warn: `e2e status warning ${tag}` };
const SPEC = {
  quality: { samples: 16, displacement: { mode: 'none' } },
  document: { placements: [] },
  outputs: [{ kind: 'image', widthPx: 256, heightPx: 256 }],
};

let sql: Sql;
let packId: string;

test.beforeAll(async () => {
  const { connect, withStaff } = await import('@pr/db');
  sql = connect({ url: process.env['DATABASE_URL']! });
  packId = randomUUID();

  await withStaff(sql, async (tx) => {
    const [org] = await tx`select id from organizations where slug = 'e2e'`;
    const orgId = org!['id'] as string;
    const productId = randomUUID();
    const variantId = randomUUID();
    const designId = randomUUID();
    const versionId = randomUUID();
    // A draft pack: invisible to every customer-facing test running alongside this one.
    await tx`
      insert into product_packs (id, key, version, name, status, manifest, digest)
      values (${packId}, ${`e2e-status-${tag}`}, '1.0.0', 'Status fixture', 'draft', '{}'::jsonb, ${Buffer.alloc(32)})`;
    await tx`
      insert into products (id, pack_id, key, name, category, facets, sort, status)
      values (${productId}, ${packId}, 'thing', 'Thing', 'things', '{}'::jsonb, 0, 'draft')`;
    await tx`
      insert into product_variants (id, product_id, key, name, dimensions_mm, material_slots, camera_presets, capabilities)
      values (${variantId}, ${productId}, 'one', 'One', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`;
    await tx`
      insert into designs (id, org_id, name, product_variant_id)
      values (${designId}, ${orgId}, ${`Status design ${tag}`}, ${variantId})`;
    await tx`
      insert into design_versions (id, design_id, org_id, version, schema_version, document)
      values (${versionId}, ${designId}, ${orgId}, 1, 1, '{}'::jsonb)`;

    // The audit's case: a worker killed mid-render. Its last word was two minutes ago; its lease
    // still has a minute to run, so nothing else would have noticed yet.
    await tx`
      insert into workers (id, kind, host, pid, engine, last_seen_at)
      values (${ghost}, 'render', 'e2e', 1, 'cycles-local', now() - interval '2 minutes')`;
    const base = { org_id: orgId, design_version_id: versionId, spec: tx.json(SPEC as never) };
    await tx`
      insert into render_jobs ${tx({
        ...base,
        id: ids.running,
        spec_hash: Buffer.from(ids.running),
        status: 'running',
        worker_id: ghost,
        stage: 'trace',
        progress: 0.2,
        attempts: 1,
        started_at: new Date(Date.now() - 150_000),
        lease_expires_at: new Date(Date.now() + 60_000),
        log: tx.json([
          { at: new Date().toISOString(), level: 'info', message: 'job claimed' },
          { at: new Date().toISOString(), level: 'info', message: 'stage', fields: { stage: 'trace' } },
        ] as never),
      } as never)}`;
    await tx`
      insert into render_jobs ${tx({
        ...base,
        id: ids.succeeded,
        spec_hash: Buffer.from(ids.succeeded),
        status: 'succeeded',
        started_at: new Date(Date.now() - 60_000),
        finished_at: new Date(),
      } as never)}`;
    await tx`
      insert into render_jobs ${tx({
        ...base,
        id: ids.failed,
        spec_hash: Buffer.from(ids.failed),
        status: 'failed',
        started_at: new Date(Date.now() - 60_000),
        finished_at: new Date(),
        error: tx.json({ code: 'oom', message: 'out of memory' } as never),
      } as never)}`;

    await tx`
      insert into service_events (service, level, message, fields, error, request_id)
      values
        ('web', 'error', ${messages.error}, ${tx.json({ route: 'renders', method: 'POST', path: '/api/renders', status: 500 } as never)},
         ${tx.json({ name: 'Error', message: 'connection reset' } as never)}, ${`req-${tag}`}),
        ('worker-render', 'warn', ${messages.warn}, '{}'::jsonb, null, null)`;
  });
});

test.afterAll(async () => {
  if (!sql) return;
  const { withStaff } = await import('@pr/db');
  await withStaff(sql, async (tx) => {
    await tx`delete from render_jobs where id in ${tx(Object.values(ids))}`;
    await tx`delete from design_versions where design_id in (select id from designs where name = ${`Status design ${tag}`})`;
    await tx`delete from designs where name = ${`Status design ${tag}`}`;
    await tx`delete from product_packs where id = ${packId}`;
    await tx`delete from workers where id = ${ghost}`;
    await tx`delete from service_events where message in ${tx(Object.values(messages))}`;
  });
  await sql.end();
});

test.describe('as staff', () => {
  test.use({ storageState: STAFF_STORAGE_STATE });

  test('the status page names every service and flags the render a dead worker holds', async ({ page }) => {
    await page.goto('/admin/status');

    await expect(page.getByTestId('status')).toBeVisible();
    await expect(page.getByTestId('status-overall')).toBeVisible();
    for (const key of ['web', 'database', 'storage', 'render-workers', 'cad-workers', 'render-queue', 'cad-queue', 'email']) {
      await expect(page.getByTestId(`service-${key}`)).toBeVisible();
    }
    // Development keeps mail on the machine; the card says so rather than claiming it sends.
    await expect(page.getByTestId('service-email')).toContainText('Development mailbox');

    const row = page.getByTestId(`status-running-${ids.running}`);
    await expect(row).toContainText('Status design');
    await expect(row).toContainText('20% · trace');
    await expect(row.getByTestId('status-concern')).toContainText('stopped reporting');
    await expect(page.getByTestId('status-attention')).toContainText(`Render ${ids.running.slice(0, 8)}`);
    await expect(page.getByTestId(`status-worker-${ghost}`)).toContainText('stale');
  });

  test('the server log shows errors and warnings, coloured by level, and filters', async ({ page }) => {
    await page.goto('/admin/status');

    const error = page.getByTestId('status-log').locator('tr', { hasText: messages.error });
    const warning = page.getByTestId('status-log').locator('tr', { hasText: messages.warn });
    await expect(error).toHaveAttribute('data-level', 'error');
    await expect(error.locator('.pill.bad')).toHaveText('error');
    await expect(error).toContainText('POST /api/renders → 500');
    await expect(error).toContainText(`request req-${tag}`);
    await expect(warning.locator('.pill.warn')).toHaveText('warning');

    await page.getByTestId('log-level').selectOption('warn');
    await expect(error).toHaveCount(0);
    await expect(warning).toBeVisible();

    await page.getByTestId('log-level').selectOption('');
    await page.getByTestId('log-service').selectOption('web');
    await expect(error).toBeVisible();
    await expect(warning).toHaveCount(0);
  });

  test('the queue flags the stuck job, shows its log, and asks before cancelling it', async ({ page }) => {
    await page.goto('/admin/queue');

    const running = page.getByTestId(`job-${ids.running}`);
    await expect(running).toContainText('stuck');
    await expect(running.getByTestId(`job-concern-${ids.running}`)).toContainText('stopped reporting');

    await running.getByTestId(`job-log-${ids.running}-toggle`).click();
    await expect(page.getByTestId(`job-log-${ids.running}`)).toContainText('job claimed');

    // Kept: nothing happens.
    await running.getByTestId(`cancel-${ids.running}`).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Cancel this render');
    await page.getByTestId('confirm-cancel').click();
    await expect(running).toHaveAttribute('data-status', 'running');

    await running.getByTestId(`cancel-${ids.running}`).click();
    await page.getByTestId('confirm-accept').click();
    await expect(page.getByTestId(`job-${ids.running}`)).toHaveAttribute('data-status', 'canceled');
  });

  test('Retry is offered for a failed render, never for one that succeeded', async ({ page }) => {
    await page.goto('/admin/queue');

    await expect(page.getByTestId(`retry-${ids.failed}`)).toBeVisible();
    await expect(page.getByTestId(`job-${ids.succeeded}`)).toBeVisible();
    await expect(page.getByTestId(`retry-${ids.succeeded}`)).toHaveCount(0);

    // And the API refuses it, for anyone who goes around the page — asked from the page, so the
    // request carries the staff session and the same-origin header a real one would.
    const status = await page.evaluate(async (id) => {
      const response = await fetch(`/api/admin/queue/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      });
      return response.status;
    }, ids.succeeded);
    expect(status).toBe(409);
  });
});
