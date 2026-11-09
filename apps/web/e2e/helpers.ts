import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Shared e2e scaffolding.
 *
 * Invitations come from the development endpoint — the stand-in for the admin console — because
 * there is no self-service sign-up and there never will be (docs/05-security.md).
 */

import type { OrientationFrame } from '@pr/design-schema';
import { PASSWORD } from './global-setup';

export { PASSWORD };

export async function invite(
  request: APIRequestContext,
  address: string,
  orgSlug = 'e2e',
): Promise<string> {
  const response = await request.post('/api/dev/invite', { data: { email: address, orgSlug } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { token: string }).token;
}

/**
 * Invites a fresh account and accepts it in the browser.
 *
 * Tests that only need "a signed-in user" use this rather than sharing one account: sign-in is rate
 * limited per address, and a shared account makes one test's failed attempts another's flake.
 */
export async function createAccount(
  page: Page,
  request: APIRequestContext,
  orgSlug = 'e2e',
): Promise<string> {
  const address = `fresh-${randomBytes(6).toString('hex')}@example.com`;
  const token = await invite(request, address, orgSlug);

  await page.goto(`/invite/accept?token=${token}`);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('confirm').fill(PASSWORD);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('account')).toBeVisible();

  return address;
}

/** The design document as the server currently has it, fetched from inside the page. */
export async function storedDesign(page: Page): Promise<StoredDocument> {
  const id = new URL(page.url()).pathname.split('/').pop()!;
  return page.evaluate(
    (designId: string) =>
      fetch(`/api/designs/${designId}`).then((r) => r.json() as Promise<{ document: unknown }>),
    id,
  ) as Promise<StoredDocument>;
}

export interface StoredDocument {
  version: number;
  document: {
    materials: Record<string, { materialKey?: string; colorHex?: string; textureScale?: number }>;
    placements: {
      zoneKey: string;
      artwork: { artworkId: string; versionId: string };
      transform: { offsetMm: { x: number; y: number }; sizeMm: { w: number; h: number } };
      finish: { kind: string; depthMm?: number; tintHex?: string; inkMaterialKey?: string };
    }[];
    scene: {
      presentationOrientationOverride?: OrientationFrame;
      environmentKey: string;
      background: { kind: string; colorHex?: string };
      camera: { kind: string; presetKey?: string; focalMm?: number; positionMm?: number[] };
    };
  };
}

/**
 * Waits until the server has the edit, not until the chip says so.
 *
 * "All changes saved" is also what the chip says *before* an edit, and the version counter moves on
 * the editor's own first save too — so both can pass against the previous state. Asking the server
 * what it stored cannot.
 */
export async function waitForStored(
  page: Page,
  predicate: (stored: StoredDocument) => boolean,
  message: string,
): Promise<void> {
  await expect
    .poll(async () => predicate(await storedDesign(page)), { timeout: 30_000, message })
    .toBe(true);
}

/**
 * The orientation wizard's Confirm waits on its 3D model. A model and its first frame take three
 * seconds on a developer machine and over twenty on a two-core runner drawing in software, so the
 * suite's fifteen-second default measured the runner. A button that never enables still fails here.
 */
export async function waitForOrientationModel(page: Page): Promise<void> {
  await expect(page.getByTestId('orientation-confirm')).toBeEnabled({ timeout: 60_000 });
}

export async function confirmPreparation(page: Page): Promise<void> {
  await page.getByTestId('preparation-keep-all').click();
  await expect(page.getByTestId('preparation-next')).toBeEnabled();
  await page.getByTestId('preparation-next').click();
  if (!(await page.getByTestId('preparation-save').isVisible())) {
    for (const checkbox of await page.locator('.preparation-objects input[type=checkbox]').all())
      await checkbox.check();
    await page.getByTestId('preparation-next').click();
  }
  for (const checkbox of await page.locator('.preparation-objects input[type=checkbox]').all())
    await checkbox.check();
  await expect(page.getByTestId('preparation-save')).toBeEnabled();
  await page.getByTestId('preparation-save').click();
  await expect(page.getByTestId('artwork-preparation')).toHaveCount(0);
}

/** Prepares artwork, explicitly chooses it from the library, and waits for placement persistence. */
export async function uploadArtwork(page: Page, file: string): Promise<void> {
  await page.getByTestId('artwork-upload').setInputFiles(file);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/artworks/preparation') && response.request().method() === 'PUT',
  );
  await confirmPreparation(page);
  const record = (await (await saved).json()) as { ref: { versionId: string } };
  await page.getByTestId(`library-${record.ref.versionId}`).click();
  await waitForStored(
    page,
    (s) =>
      s.document.placements.some(
        (placement) => placement.artwork.versionId === record.ref.versionId,
      ),
    'artwork was never placed',
  );
}

/**
 * Open a page and wait until the editor is actually interactive.
 *
 * `goto` resolves when the markup is there, and the editor is server-rendered — so its controls are
 * painted and look ready roughly 200 ms before React attaches a handler to any of them. A click in
 * that gap lands on a node React does not know about and vanishes silently, which is a flake that
 * looks exactly like a broken feature. `data-hydrated` is set from an effect, so it cannot appear
 * before handlers are live.
 */
export async function openEditor(page: Page, path = '/design/demo'): Promise<void> {
  await page.goto(path);
  await page.locator('.editor[data-hydrated]').waitFor();
}
