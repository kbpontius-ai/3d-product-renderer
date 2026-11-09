import { recordAudit, withTenant, type Sql, type Tx } from '@pr/db';
import { AdminError } from './errors.js';
import type { Role, UserStatus } from './users.js';

/**
 * What an organisation's owner may do to their own organisation (F-ORG-01..05).
 *
 * Deliberately separate from `users.ts`, which is the staff console's. Every function there opens
 * `withStaff` — it escalates past tenancy on purpose, because staff work across organisations.
 * Nothing here may do that, so everything here opens `withTenant` and lives inside the same
 * row-level security an ordinary request does.
 *
 * **Row-level security does not enforce role.** The `users` policy is tenancy only —
 * `org_id = app_current_org()` — so as far as the database is concerned any member of an
 * organisation may update any colleague's row. The database stops Beta touching Alpha; it does not
 * stop an Alpha member suspending an Alpha owner. That check exists nowhere but here and in
 * `authorize`, which is why every function in this file re-checks the actor's role rather than
 * trusting that a route remembered to.
 */

export interface OrgActor {
  userId: string;
  orgId: string;
  role: Role;
}

export interface MemberRecord {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  /** Packs withheld from this member. Empty is the ordinary case. */
  withheldPackIds: string[];
}

export interface PackSummary {
  id: string;
  key: string;
  name: string;
  version: string;
}

export interface OrgOverview {
  name: string;
  seats: { total: number; active: number; suspended: number; invited: number };
  quotas: { rendersPerDay: number; gpuSecondsPerMonth: number; maxResolutionPx: number };
  rendersToday: number;
}

/** Only an owner administers an organisation; staff do it through `/admin`. */
function assertOwner(actor: OrgActor): void {
  if (actor.role !== 'owner' && actor.role !== 'staff') {
    throw new AdminError('forbidden', 'only an owner may administer the organisation');
  }
}

/**
 * The row for a member of the actor's own organisation.
 *
 * Answers `not_found` for somebody in another organisation rather than `forbidden`: the two are
 * distinguishable to an attacker enumerating ids, and "no such person" is true from where they are
 * standing. Row-level security has already made the select return nothing; this turns that into the
 * right error.
 */
async function requireMember(tx: Tx, userId: string): Promise<Record<string, unknown>> {
  const [user] = (await tx`
    select id, org_id, email, role, status from users where id = ${userId}`) as unknown as Record<
    string,
    unknown
  >[];
  if (!user) throw new AdminError('not_found', 'no such member');
  return user;
}

/** An organisation with no owner has nobody who can invite one back. */
async function assertNotLastOwner(tx: Tx, userId: string): Promise<void> {
  const [row] = (await tx`
    select count(*)::int as remaining from users
    where role = 'owner' and status = 'active' and id <> ${userId}`) as unknown as {
    remaining: number;
  }[];
  if ((row?.remaining ?? 0) === 0) {
    throw new AdminError('conflict', 'that would leave the organisation without an active owner');
  }
}

export async function listMembers(sql: Sql, actor: OrgActor): Promise<MemberRecord[]> {
  assertOwner(actor);

  return withTenant(sql, { orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const rows = (await tx`
      select u.id, u.email, u.role, u.status, u.last_login_at, u.created_at,
             coalesce(
               (select array_agg(d.pack_id::text) from user_pack_denials d where d.user_id = u.id),
               '{}'
             ) as withheld
      from users u
      order by u.role, u.email`) as unknown as Record<string, unknown>[];

    return rows.map(toMember);
  });
}

export async function getMember(sql: Sql, actor: OrgActor, userId: string): Promise<MemberRecord> {
  assertOwner(actor);

  return withTenant(sql, { orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    await requireMember(tx, userId);
    const [row] = (await tx`
      select u.id, u.email, u.role, u.status, u.last_login_at, u.created_at,
             coalesce(
               (select array_agg(d.pack_id::text) from user_pack_denials d where d.user_id = u.id),
               '{}'
             ) as withheld
      from users u where u.id = ${userId}`) as unknown as Record<string, unknown>[];
    return toMember(row!);
  });
}

/**
 * Suspend or reinstate.
 *
 * Suspension revokes live sessions in the same transaction, exactly as the staff version does — an
 * owner who suspends somebody means now, and a row saying `suspended` while the browser keeps
 * saving designs is a lie the audit log would faithfully record.
 */
export async function setMemberStatus(
  sql: Sql,
  actor: OrgActor,
  userId: string,
  status: 'active' | 'suspended',
): Promise<MemberRecord> {
  assertOwner(actor);
  if (userId === actor.userId) {
    // Not a safety rail so much as a courtesy: it would revoke the session making the request.
    throw new AdminError('forbidden', 'you cannot suspend your own account');
  }

  await withTenant(sql, { orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const user = await requireMember(tx, userId);
    if (user['role'] === 'staff') {
      throw new AdminError('forbidden', 'staff accounts are administered by staff');
    }
    if (status === 'suspended' && user['role'] === 'owner') await assertNotLastOwner(tx, userId);
    if (status === 'active' && user['status'] === 'invited') {
      throw new AdminError('conflict', 'that invitation has not been accepted yet');
    }

    await tx`update users set status = ${status} where id = ${userId}`;
    if (status === 'suspended') {
      await tx`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
    }

    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: `org.member.${status}`,
      targetType: 'user',
      targetId: userId,
      metadata: { email: user['email'] },
    });
  });

  return getMember(sql, actor, userId);
}

/** Owner or member, and nothing else — an owner must not be able to mint staff. */
export async function setMemberRole(
  sql: Sql,
  actor: OrgActor,
  userId: string,
  role: 'owner' | 'member',
): Promise<MemberRecord> {
  assertOwner(actor);
  if (role !== 'owner' && role !== 'member') {
    throw new AdminError('invalid', 'role must be owner or member');
  }

  await withTenant(sql, { orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const user = await requireMember(tx, userId);
    if (user['role'] === 'staff') {
      throw new AdminError('forbidden', 'staff accounts are administered by staff');
    }
    if (user['role'] === 'owner' && role !== 'owner') await assertNotLastOwner(tx, userId);

    await tx`update users set role = ${role} where id = ${userId}`;
    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'org.member.role',
      targetType: 'user',
      targetId: userId,
      metadata: { email: user['email'], from: user['role'], to: role },
    });
  });

  return getMember(sql, actor, userId);
}

/**
 * Every product the organisation has, whoever is asking.
 *
 * Read with no user in the context on purpose. `product_packs` now hides what is withheld from the
 * *current* user, which is right for the catalog and wrong for the page that manages withholding —
 * an owner cannot administer a list they have been filtered out of. Tenancy still applies: this is
 * the organisation's catalog, not everyone's.
 */
export async function listOrgPacks(sql: Sql, actor: OrgActor): Promise<PackSummary[]> {
  assertOwner(actor);

  return withTenant(sql, { orgId: actor.orgId, userId: null }, async (tx) => {
    const rows = (await tx`
      select id, key, name, version from product_packs
      where status = 'published' order by name`) as unknown as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r['id'] as string,
      key: r['key'] as string,
      name: r['name'] as string,
      version: r['version'] as string,
    }));
  });
}

/**
 * Grant or withhold one product for one member.
 *
 * Owners cannot be withheld from: they administer the catalog, and an administrator who can hide a
 * product from themselves has built themselves a support ticket. Members are the only targets.
 */
export async function setPackAccess(
  sql: Sql,
  actor: OrgActor,
  userId: string,
  packId: string,
  allowed: boolean,
): Promise<void> {
  assertOwner(actor);

  await withTenant(sql, { orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const user = await requireMember(tx, userId);
    if (user['role'] !== 'member') {
      throw new AdminError('forbidden', 'owners and staff see the whole catalog');
    }

    // Confirmed against the organisation's own catalog, so an id from somewhere else is a 404
    // rather than a row that quietly does nothing.
    const [pack] = (await tx`
      select id, name from product_packs where id = ${packId}`) as unknown as Record<string, unknown>[];
    if (!pack) throw new AdminError('not_found', 'no such product');

    if (allowed) {
      await tx`delete from user_pack_denials where user_id = ${userId} and pack_id = ${packId}`;
    } else {
      await tx`
        insert into user_pack_denials (user_id, pack_id, denied_by)
        values (${userId}, ${packId}, ${actor.userId})
        on conflict (user_id, pack_id) do nothing`;
    }

    await recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: allowed ? 'org.access.granted' : 'org.access.withheld',
      targetType: 'user',
      targetId: userId,
      metadata: { email: user['email'], pack: pack['name'] },
    });
  });
}

export async function orgOverview(sql: Sql, actor: OrgActor): Promise<OrgOverview> {
  assertOwner(actor);

  return withTenant(sql, { orgId: actor.orgId, userId: actor.userId }, async (tx) => {
    const [org] = (await tx`select name from organizations where id = ${actor.orgId}`) as unknown as {
      name: string;
    }[];
    const [seats] = (await tx`
      select count(*)::int as total,
             count(*) filter (where status = 'active')::int as active,
             count(*) filter (where status = 'suspended')::int as suspended,
             count(*) filter (where status = 'invited')::int as invited
      from users`) as unknown as Record<string, number>[];
    const [quota] = (await tx`
      select renders_per_day, gpu_seconds_per_month, max_resolution_px
      from org_quotas where org_id = ${actor.orgId}`) as unknown as Record<string, number>[];
    // `queued_at`, not `created_at`: a render job is stamped when it enters the queue, which is
    // also what the daily quota counts against.
    const [renders] = (await tx`
      select count(*)::int as n from render_jobs
      where queued_at >= date_trunc('day', now())`) as unknown as { n: number }[];

    return {
      name: org?.name ?? '',
      seats: {
        total: seats?.['total'] ?? 0,
        active: seats?.['active'] ?? 0,
        suspended: seats?.['suspended'] ?? 0,
        invited: seats?.['invited'] ?? 0,
      },
      quotas: {
        rendersPerDay: quota?.['renders_per_day'] ?? 0,
        gpuSecondsPerMonth: quota?.['gpu_seconds_per_month'] ?? 0,
        maxResolutionPx: quota?.['max_resolution_px'] ?? 0,
      },
      rendersToday: renders?.n ?? 0,
    };
  });
}

function toMember(row: Record<string, unknown>): MemberRecord {
  const withheld = (row['withheld'] ?? []) as string[];
  return {
    id: row['id'] as string,
    email: row['email'] as string,
    role: row['role'] as Role,
    status: row['status'] as UserStatus,
    lastLoginAt: row['last_login_at'] ? String(row['last_login_at']) : null,
    createdAt: String(row['created_at']),
    withheldPackIds: withheld,
  };
}
