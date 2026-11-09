import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token handling for invitations, password resets and sessions.
 *
 * The raw token exists in exactly two places: the email or cookie it travels in, and the caller's
 * hands for the moment it is created. What the database stores is a hash, so a database disclosure
 * does not hand anyone a working invitation link (docs/05-security.md, docs/18-auth-impl.md).
 */

export const TOKEN_BYTES = 32; // 256 bits

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time comparison, for the rare case where two hashes are compared in application code. */
export function tokensEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface TokenTtls {
  inviteMs: number;
  resetMs: number;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
}

export const DEFAULT_TTLS: TokenTtls = {
  inviteMs: 7 * 24 * 60 * 60 * 1000,
  resetMs: 60 * 60 * 1000,
  sessionIdleMs: 14 * 24 * 60 * 60 * 1000,
  sessionAbsoluteMs: 30 * 24 * 60 * 60 * 1000,
};

/** Session cookie settings. `__Host-` forbids a subdomain from setting it. */
export const SESSION_COOKIE = {
  name: '__Host-session',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;
