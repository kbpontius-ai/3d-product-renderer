import 'server-only';
import { enrichLogContext } from '@pr/observability';
import type { OrgActor } from '@pr/admin';
import type { SessionPrincipal } from '@pr/auth';
import { getPrincipal } from './auth.js';
import { databaseConfigured } from './db.js';
import { HttpError } from './http.js';

/**
 * The owner gate (W-16).
 *
 * The counterpart to `requireStaff`, and deliberately its own function rather than a parameter on
 * it: the two guard different things. Staff is a global capability; this is a role *within one
 * organisation*, and every call site downstream of it works inside that organisation only.
 *
 * A member gets 404 rather than 403, exactly as a non-staff account does from `/admin`. Whether
 * this organisation has an administration area is not something an ordinary member needs to learn
 * from an error code.
 */

export async function requireOwner(): Promise<SessionPrincipal> {
  if (!databaseConfigured()) throw new HttpError(503, 'not_configured');

  const principal = await getPrincipal();
  if (!principal) throw new HttpError(401, 'unauthenticated');
  if (principal.role !== 'owner' && principal.role !== 'staff') {
    throw new HttpError(404, 'not_found');
  }

  enrichLogContext({ orgId: principal.orgId, userId: principal.userId });
  return principal;
}

/** The principal as the admin operations want it. */
export function actorFor(principal: SessionPrincipal): OrgActor {
  return { userId: principal.userId, orgId: principal.orgId, role: principal.role };
}

/** True when the current session may see the organisation area; for nav, not for authorization. */
export async function isOwner(): Promise<boolean> {
  if (!databaseConfigured()) return false;
  const role = (await getPrincipal())?.role;
  return role === 'owner' || role === 'staff';
}
