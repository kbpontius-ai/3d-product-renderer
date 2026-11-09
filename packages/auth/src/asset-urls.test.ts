import { describe, expect, it } from 'vitest';
import {
  ASSET_URL_TTL_MS,
  generateAssetSecret,
  signAssetKey,
  verifyAssetSignature,
} from './asset-urls.js';

const SECRET = 'a-secret-nobody-else-has';
const KEY = 'renders/org-a/job-1/output-0.png';
const VIEWER = 'user-1';

describe('signAssetKey', () => {
  it('gives a different signature for a different key, viewer or expiry', () => {
    const base = signAssetKey(SECRET, KEY, VIEWER, 1000);

    expect(signAssetKey(SECRET, 'renders/org-a/job-2/output-0.png', VIEWER, 1000)).not.toBe(base);
    expect(signAssetKey(SECRET, KEY, 'user-2', 1000)).not.toBe(base);
    expect(signAssetKey(SECRET, KEY, VIEWER, 2000)).not.toBe(base);
    expect(signAssetKey('another-secret', KEY, VIEWER, 1000)).not.toBe(base);
  });

  it('is stable for the same inputs, or a page could not be reloaded', () => {
    expect(signAssetKey(SECRET, KEY, VIEWER, 1000)).toBe(signAssetKey(SECRET, KEY, VIEWER, 1000));
  });
});

describe('verifyAssetSignature', () => {
  const sign = (expiresAt: number, viewer = VIEWER, key = KEY) => ({
    expiresAt,
    signature: signAssetKey(SECRET, key, viewer, expiresAt),
  });

  it('accepts a current signature made for this viewer', () => {
    expect(verifyAssetSignature(SECRET, KEY, VIEWER, sign(5000), 4000)).toBe(true);
  });

  it('refuses one that has expired', () => {
    expect(verifyAssetSignature(SECRET, KEY, VIEWER, sign(5000), 5001)).toBe(false);
  });

  it('refuses a URL issued to somebody else, even inside its lifetime', () => {
    // The case this exists for: a link pasted into a channel a colleague can read.
    expect(verifyAssetSignature(SECRET, KEY, 'user-2', sign(5000), 4000)).toBe(false);
  });

  it('refuses a signature for a different key', () => {
    const other = sign(5000, VIEWER, 'renders/org-a/job-2/output-0.png');
    expect(verifyAssetSignature(SECRET, KEY, VIEWER, other, 4000)).toBe(false);
  });

  it('refuses an expiry that was edited after signing', () => {
    // The expiry is inside the signed material, so pushing it out invalidates the signature — which
    // is the whole reason it is signed rather than merely attached.
    const original = sign(5000);
    expect(
      verifyAssetSignature(SECRET, KEY, VIEWER, { ...original, expiresAt: 9_999_999 }, 4000),
    ).toBe(false);
  });

  it('refuses a missing or malformed signature rather than throwing', () => {
    expect(verifyAssetSignature(SECRET, KEY, VIEWER, { expiresAt: 5000, signature: '' }, 4000)).toBe(false);
    expect(verifyAssetSignature(SECRET, KEY, VIEWER, { expiresAt: NaN, signature: 'x' }, 4000)).toBe(false);
    expect(
      verifyAssetSignature(SECRET, KEY, VIEWER, { expiresAt: 5000, signature: 'not-base64url!!' }, 4000),
    ).toBe(false);
  });

  it('refuses a signature made with a different secret', () => {
    const forged = { expiresAt: 5000, signature: signAssetKey('wrong', KEY, VIEWER, 5000) };
    expect(verifyAssetSignature(SECRET, KEY, VIEWER, forged, 4000)).toBe(false);
  });
});

describe('generateAssetSecret', () => {
  it('is long and different every time', () => {
    const a = generateAssetSecret();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(generateAssetSecret());
  });
});

describe('ASSET_URL_TTL_MS', () => {
  it('is short enough that a leaked URL is worth little, and long enough to load a page', () => {
    expect(ASSET_URL_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(ASSET_URL_TTL_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
