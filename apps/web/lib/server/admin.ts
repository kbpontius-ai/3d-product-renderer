import 'server-only';
import { enrichLogContext } from '@pr/observability';
import type { SessionPrincipal } from '@pr/auth';
import { getPrincipal } from './auth.js';
import { databaseConfigured } from './db.js';
import { HttpError } from './http.js';

/**
 * The staff gate (W-11..W-13).
 *
 * One function, used by every admin page and route, because "is this person staff" answered in two
 * places eventually gets answered differently. Staff is a role on the account rather than a
 * separate login: there is no second credential to steal, and every action it permits is written to
 * the audit log.
 */

export async function requireStaff(): Promise<SessionPrincipal> {
  if (!databaseConfigured()) throw new HttpError(503, 'not_configured');

  const principal = await getPrincipal();
  if (!principal) throw new HttpError(401, 'unauthenticated');
  if (principal.role !== 'staff') {
    // Deliberately the same answer a signed-out request gets from an admin route: whether this
    // deployment has an admin console is not something an ordinary account needs to learn.
    throw new HttpError(404, 'not_found');
  }

  enrichLogContext({ orgId: principal.orgId, userId: principal.userId, staff: true });
  return principal;
}

/** True when the current session may see the admin console; for nav, not for authorization. */
export async function isStaff(): Promise<boolean> {
  if (!databaseConfigured()) return false;
  return (await getPrincipal())?.role === 'staff';
}
