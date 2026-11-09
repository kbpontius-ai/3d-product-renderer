import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring, per-viewer asset URLs (F-PLAT-04, docs/05-security.md).
 *
 * The session already decides who may read an asset, and the key already names the organisation
 * that owns it, so this is the third thing rather than the only thing. What it adds is what those
 * two cannot: a URL stops working, and it only works for the person it was issued to.
 *
 * That matters because URLs travel further than sessions do. They end up in a screenshot of a
 * browser bar, in a bug report, in a chat message to a colleague, in a proxy log. None of those is
 * a breach on its own — the reader still needs a session — but "still needs a session" is a much
 * weaker sentence than "expired an hour ago and was not yours anyway".
 *
 * It is also what makes serving bytes straight from object storage possible later without a
 * redesign: there the session cannot be checked at all, and the signature is the whole of the
 * access control.
 */

/** How long an issued URL stays good. Long enough to load a page, short enough to be worth little. */
export const ASSET_URL_TTL_MS = 15 * 60 * 1000;

export interface AssetSignature {
  /** Expiry, as milliseconds since the epoch. */
  expiresAt: number;
  signature: string;
}

/**
 * Signs a key for one viewer.
 *
 * The expiry is inside the signed material, not beside it — otherwise anyone holding a URL could
 * edit the timestamp and keep it forever, which is the classic way this is got wrong.
 */
export function signAssetKey(
  secret: string,
  key: string,
  viewerId: string,
  expiresAt: number,
): string {
  return createHmac('sha256', secret).update(`${key}\n${viewerId}\n${expiresAt}`).digest('base64url');
}

/**
 * Whether a presented signature is this viewer's, and still current.
 *
 * Compared in constant time. The comparison is against a value an attacker chooses, and a
 * byte-by-byte one leaks how much of a guess was right.
 */
export function verifyAssetSignature(
  secret: string,
  key: string,
  viewerId: string,
  presented: { expiresAt: number; signature: string },
  now = Date.now(),
): boolean {
  if (!Number.isFinite(presented.expiresAt) || presented.expiresAt < now) return false;

  const expected = Buffer.from(signAssetKey(secret, key, viewerId, presented.expiresAt), 'utf8');
  const actual = Buffer.from(presented.signature, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A secret to sign with, for a deployment that has not been given one. */
export function generateAssetSecret(): string {
  return randomBytes(32).toString('base64url');
}
