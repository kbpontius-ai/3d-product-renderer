import 'server-only';
import { cookies } from 'next/headers';
import { AuthService, SESSION_COOKIE, type SessionPrincipal } from '@pr/auth';
import { enrichLogContext } from '@pr/observability';
import type { TenantContext } from '@pr/db';
import { databaseConfigured, getSql } from './db.js';
import { HttpError } from './http.js';
import { getMailer } from './mailer.js';

/**
 * Server-side auth wiring: one service instance, cookie handling, and the guards pages use.
 *
 * Session validation happens in server components and route handlers rather than middleware,
 * because the check needs the database and Next's middleware runs on a runtime that should not hold
 * database connections.
 */

const globalForAuth = globalThis as unknown as { __prAuth?: AuthService };

export function getAuthService(): AuthService {
  globalForAuth.__prAuth ??= new AuthService({
    sql: getSql(),
    mailer: getMailer(),
    appUrl: process.env['APP_URL'] ?? 'http://localhost:3000',
    // The breached-password lookup talks to a third party, which a deployment behind an air gap
    // does not have. Off means unchecked rather than safe; the local strength gate still applies.
    breach: { enabled: process.env['PASSWORD_BREACH_CHECK'] !== 'off' },
  });
  return globalForAuth.__prAuth;
}

/**
 * The tenant context every catalog and design query runs inside.
 *
 * Routes call this rather than reading the cookie themselves, so "who is asking" and "which
 * organisation's rows are visible" are decided in one place.
 */
export async function requireTenant(): Promise<TenantContext & { principal: SessionPrincipal }> {
  if (!databaseConfigured()) throw new HttpError(503, 'not_configured');

  const principal = await getPrincipal();
  if (!principal) throw new HttpError(401, 'unauthenticated');

  // Everything this request logs from here on says whose it was.
  enrichLogContext({ orgId: principal.orgId, userId: principal.userId });

  return { orgId: principal.orgId, userId: principal.userId, principal };
}

export async function getPrincipal(): Promise<SessionPrincipal | null> {
  const token = (await cookies()).get(SESSION_COOKIE.name)?.value;
  if (!token) return null;
  return getAuthService().validateSession(token);
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set({
    name: SESSION_COOKIE.name,
    value: token,
    httpOnly: SESSION_COOKIE.httpOnly,
    sameSite: SESSION_COOKIE.sameSite,
    path: SESSION_COOKIE.path,
    // `__Host-` requires Secure unconditionally: a browser rejects the cookie outright without it,
    // so making it conditional broke sign-in under `next dev` rather than relaxing it. http://localhost
    // and http://127.0.0.1 are trustworthy origins, so Secure costs development nothing.
    secure: SESSION_COOKIE.secure,
    maxAge: 14 * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE.name);
}

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE.name)?.value ?? null;
}

/**
 * Same-origin check for state-changing requests.
 *
 * SameSite=Lax already blocks the cross-site form post; this is the belt to that pair of braces.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return; // same-origin form posts may omit it
  const host = request.headers.get('host');
  if (!host || new URL(origin).host !== host) {
    throw new Error('cross-origin request refused');
  }
}
