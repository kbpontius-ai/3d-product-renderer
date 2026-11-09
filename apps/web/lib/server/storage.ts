import 'server-only';
import {
  ASSET_URL_TTL_MS,
  generateAssetSecret,
  signAssetKey,
  verifyAssetSignature,
} from '@pr/auth';
import { log } from '@pr/observability';
import { defaultStorageRoot, localStorage, type Storage } from '@pr/storage';

/**
 * Asset delivery, addressed by storage key.
 *
 * Everything servable lives in object storage — the local adapter here, S3 in production. Pack
 * assets get there through pack import, uploaded artwork through the artwork pipeline, and renders
 * through the worker; nothing reads from the repository at request time.
 */

const globalForStorage = globalThis as unknown as { __prStorage?: Storage };

export function getStorage(): Storage {
  globalForStorage.__prStorage ??= localStorage(defaultStorageRoot());
  return globalForStorage.__prStorage;
}

const path = (storageKey: string): string =>
  `/api/assets/${storageKey.split('/').map(encodeURIComponent).join('/')}`;

/**
 * The signing secret for asset URLs (F-PLAT-04).
 *
 * A deployment sets `ASSET_URL_SECRET`. Without one this generates a secret per process, which is
 * right for development — restart and the outstanding URLs stop working, which is nothing, because
 * every page issues fresh ones when it renders. It is wrong for a fleet, where two servers would
 * sign differently and half the images on a page would fail, so the warning says so once.
 */
const globalForSecret = globalThis as unknown as { __prAssetSecret?: string };

function assetSecret(): string {
  const configured = process.env['ASSET_URL_SECRET'];
  if (configured) return configured;

  if (!globalForSecret.__prAssetSecret) {
    globalForSecret.__prAssetSecret = generateAssetSecret();
    log.warn(
      'ASSET_URL_SECRET is not set; signing asset URLs with a secret that lasts one process',
    );
  }
  return globalForSecret.__prAssetSecret;
}

/**
 * Prefixes served to anyone who is signed in: pack assets, which the catalog has already decided
 * who may see. They carry no tenant data, so a signature would protect nothing and would stop the
 * preview resolving a material's textures for itself in the browser.
 */
const SHARED_PREFIXES = new Set(['packs']);

/**
 * Prefixes no client may ever read, whoever they are (F-PLAT-04, docs/23-cad-ingestion.md).
 *
 * Source CAD is the most valuable file a customer's supplier owns, and "source CAD never leaves the
 * server" is a security requirement rather than a preference. The tenancy check above would already
 * refuse another organisation's, and the signature would already refuse an unsigned link — but both
 * of those would happily serve a file to the organisation that owns it, and this must not be served
 * to anyone at all.
 *
 * Named explicitly rather than left out of the shared list, so it is refused by a rule someone has
 * to delete on purpose instead of by an omission a refactor could quietly undo. The ingestion
 * pipeline does not exist yet; the door is being shut before it is built rather than after.
 */
const DENIED_PREFIXES = new Set(['cad-source', 'artwork-source']);

export const isDeniedAsset = (storageKey: string): boolean =>
  DENIED_PREFIXES.has(storageKey.split('/')[0] ?? '');

export const isSharedAsset = (storageKey: string): boolean =>
  SHARED_PREFIXES.has(storageKey.split('/')[0] ?? '');

/**
 * Where a storage key is served from, signed for one viewer when it belongs to one.
 *
 * The viewer is required rather than optional: an asset URL that nobody signed is one the route
 * will refuse, and finding that out at request time is worse than at the call site.
 */
export const assetUrl = (storageKey: string, viewerId: string): string => {
  if (isDeniedAsset(storageKey)) {
    throw new Error(`${storageKey} is never served to a client`);
  }
  if (isSharedAsset(storageKey)) return path(storageKey);

  const expiresAt = Date.now() + ASSET_URL_TTL_MS;
  const signature = signAssetKey(assetSecret(), storageKey, viewerId, expiresAt);
  return `${path(storageKey)}?e=${expiresAt}&s=${signature}`;
};

/**
 * The URL for an asset that is the same for everyone: pack meshes and textures.
 *
 * Separate from `assetUrl` rather than making the viewer optional there, so that "this needs no
 * signature" is a decision someone made at the call site and not an argument they forgot.
 */
export const sharedAssetUrl = (storageKey: string): string => {
  if (!isSharedAsset(storageKey)) {
    throw new Error(`${storageKey} belongs to an organisation; sign it for a viewer instead`);
  }
  return path(storageKey);
};

/** Checks a presented signature against the viewer asking for the asset. */
export const assetSignatureValid = (
  storageKey: string,
  viewerId: string,
  presented: { expiresAt: number; signature: string },
): boolean => verifyAssetSignature(assetSecret(), storageKey, viewerId, presented);

export const readAsset = (segments: string[]) => getStorage().get(segments.join('/'));
