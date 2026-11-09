/**
 * Authorization policy.
 *
 * One module decides who may do what. Route handlers call `authorize` explicitly AND run inside a
 * tenant transaction: the policy expresses intent, row-level security catches mistakes.
 */
import { ForbiddenError } from './errors.js';

export type Role = 'staff' | 'owner' | 'member';

export type Action =
  | 'design.read'
  | 'design.write'
  | 'design.delete'
  | 'artwork.upload'
  | 'artwork.delete'
  | 'render.submit'
  | 'render.cancel'
  | 'invite.create'
  | 'invite.revoke'
  | 'member.remove'
  | 'quota.read'
  | 'quota.write'
  | 'catalog.publish'
  | 'admin.read'
  | 'admin.write';

export interface Principal {
  userId: string;
  orgId: string;
  role: Role;
}

export interface Resource {
  orgId?: string;
}

const OWNER_ACTIONS = new Set<Action>([
  'invite.create',
  'invite.revoke',
  'member.remove',
  'quota.read',
]);

const STAFF_ONLY: Action[] = ['catalog.publish', 'admin.read', 'admin.write', 'quota.write'];

export function can(principal: Principal, action: Action, resource: Resource = {}): boolean {
  // Cross-tenant access is refused before role is even considered — except for staff, whose every
  // action is audited.
  if (resource.orgId && resource.orgId !== principal.orgId && principal.role !== 'staff') {
    return false;
  }

  if (principal.role === 'staff') return true;
  if (STAFF_ONLY.includes(action)) return false;
  if (OWNER_ACTIONS.has(action)) return principal.role === 'owner';
  return true; // members do design work
}

export function authorize(principal: Principal, action: Action, resource: Resource = {}): void {
  if (!can(principal, action, resource)) throw new ForbiddenError(action);
}
