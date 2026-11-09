import { recordAudit, type Sql, withStaff } from '@pr/db';
import { AdminError } from './errors.js';

/**
 * People (F-ADM-06).
 *
 * Suspension and deletion both end the account's sessions in the same transaction that changes it.
 * An administrator who suspends someone means "now", and a row that says `suspended` while the
 * browser tab keeps saving designs is a lie the audit log would happily record.
 */

export type UserStatus = 'invited' | 'active' | 'suspended';
export type Role = 'staff' | 'owner' | 'member';

export interface UserRecord {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  role: Role;
  status: UserStatus;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  sessions: number;
  createdAt: string;
}

export interface UserFilters {
  orgId?: string;
  query?: string;
  role?: Role;
  status?: UserStatus;
}

export async function countUsers(sql: Sql, options: UserFilters = {}): Promise<number> {
  const like = options.query ? `%${options.query.trim().toLowerCase()}%` : null;
  return withStaff(sql, async (tx) => {
    const [row] = await tx`
      select count(*)::int as total from users u
      where (${options.orgId ?? null}::uuid is null or u.org_id = ${options.orgId ?? null})
        and (${like}::text is null or u.email::text ilike ${like})
        and (${options.role ?? null}::text is null or u.role = ${options.role ?? null})
        and (${options.status ?? null}::text is null or u.status = ${options.status ?? null})`;
    return Number(row?.['total'] ?? 0);
  });
}

export async function invitationExpiry(
  sql: Sql,
  orgId: string,
  email: string,
): Promise<string | null> {
  return withStaff(sql, async (tx) => {
    const [row] = await tx`
      select expires_at from invitations
      where org_id = ${orgId} and email = ${email} and consumed_at is null and revoked_at is null
      order by created_at desc, id desc limit 1`;
    return date(row?.['expires_at']);
  });
}

export async function listUsers(
  sql: Sql,
  options: UserFilters & { limit?: number; offset?: number } = {},
): Promise<UserRecord[]> {
  const like = options.query ? `%${options.query.trim().toLowerCase()}%` : null;

  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select u.*, o.name as org_name,
        (select count(*) from sessions s
          where s.user_id = u.id and s.revoked_at is null and s.absolute_expires_at > now()
            and s.idle_expires_at > now()) as sessions
      from users u
      join organizations o on o.id = u.org_id
      where (${options.orgId ?? null}::uuid is null or u.org_id = ${options.orgId ?? null})
        and (${like}::text is null or u.email::text ilike ${like})
        and (${options.role ?? null}::text is null or u.role = ${options.role ?? null})
        and (${options.status ?? null}::text is null or u.status = ${options.status ?? null})
      order by u.created_at desc, u.id desc
      limit ${options.limit ?? 200} offset ${options.offset ?? 0}`;

    return rows.map(toUser);
  });
}

export async function getUser(sql: Sql, userId: string, orgId?: string): Promise<UserRecord> {
  const [user] = await withStaff(sql, async (tx) => {
    const rows = await tx`
      select u.*, o.name as org_name,
        (select count(*) from sessions s
          where s.user_id = u.id and s.revoked_at is null and s.absolute_expires_at > now()
            and s.idle_expires_at > now()) as sessions
      from users u join organizations o on o.id = u.org_id
      where u.id = ${userId} and (${orgId ?? null}::uuid is null or u.org_id = ${orgId ?? null})`;
    return rows.map(toUser);
  });

  if (!user) throw new AdminError('not_found', 'no such user');
  return user;
}

export async function setUserStatus(
  sql: Sql,
  userId: string,
  status: Extract<UserStatus, 'active' | 'suspended'>,
  actorId: string | null,
  orgId?: string,
): Promise<UserRecord> {
  await withStaff(sql, async (tx) => {
    const [user] = await tx`select id, org_id, email, role, status from users where id = ${userId}
      and (${orgId ?? null}::uuid is null or org_id = ${orgId ?? null})`;
    if (!user) throw new AdminError('not_found', 'no such user');
    if (userId === actorId)
      throw new AdminError('forbidden', 'you cannot suspend or restore your own account');

    if (status === 'suspended' && user['role'] === 'owner') {
      await assertNotLastOwner(tx, user['org_id'] as string, userId);
    }
    // An invited account has never had a password; reactivating it would produce an account nobody
    // can sign in to, so status only moves between the two states an account can actually be in.
    if (status === 'active' && user['status'] === 'invited') {
      throw new AdminError('conflict', 'that invitation has not been accepted yet');
    }

    await tx`update users set status = ${status} where id = ${userId}`;
    if (status === 'suspended') {
      await tx`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
    }

    await recordAudit(tx, {
      orgId: user['org_id'] as string,
      actorUserId: actorId,
      action: `user.${status}`,
      targetType: 'user',
      targetId: userId,
      metadata: { email: user['email'] },
    });
  });

  return getUser(sql, userId, orgId);
}

export async function setUserRole(
  sql: Sql,
  userId: string,
  role: Role,
  actorId: string | null,
  orgId?: string,
): Promise<UserRecord> {
  await withStaff(sql, async (tx) => {
    const [user] = await tx`select id, org_id, email, role from users where id = ${userId}
      and (${orgId ?? null}::uuid is null or org_id = ${orgId ?? null})`;
    if (!user) throw new AdminError('not_found', 'no such user');
    // Staff and owner are one column, so a staff member making themselves an organisation's owner
    // stopped being staff and lost this console mid-session. Somebody else changes your role.
    if (userId === actorId) throw new AdminError('forbidden', 'you cannot change your own role');
    if (user['role'] === 'owner' && role !== 'owner') {
      await assertNotLastOwner(tx, user['org_id'] as string, userId);
    }

    await tx`update users set role = ${role} where id = ${userId}`;
    await recordAudit(tx, {
      orgId: user['org_id'] as string,
      actorUserId: actorId,
      action: 'user.role_changed',
      targetType: 'user',
      targetId: userId,
      metadata: { from: user['role'], to: role },
    });
  });

  return getUser(sql, userId, orgId);
}

/**
 * Removes an account.
 *
 * Their designs are not removed with them: work belongs to the organisation that paid for it, and
 * `designs.created_by` is nullable precisely so a departure does not delete a catalogue of designs
 * someone is still selling.
 */
export async function deleteUser(
  sql: Sql,
  userId: string,
  actorId: string | null,
  orgId?: string,
): Promise<void> {
  await withStaff(sql, async (tx) => {
    const [user] = await tx`select id, org_id, email, role from users where id = ${userId}
      and (${orgId ?? null}::uuid is null or org_id = ${orgId ?? null})`;
    if (!user) throw new AdminError('not_found', 'no such user');
    if (userId === actorId) throw new AdminError('forbidden', 'you cannot delete your own account');
    if (user['role'] === 'owner') await assertNotLastOwner(tx, user['org_id'] as string, userId);

    // What they made stays with the organisation: every reference to the person is `on delete set
    // null` (migration 0010), so this cannot trip over a table somebody forgot to list here.
    await tx`delete from users where id = ${userId}
      and (${orgId ?? null}::uuid is null or org_id = ${orgId ?? null})`;

    await recordAudit(tx, {
      orgId: user['org_id'] as string,
      actorUserId: actorId,
      action: 'user.deleted',
      targetType: 'user',
      targetId: userId,
      metadata: { email: user['email'] },
    });
  });
}

/** An organisation with no owner has nobody who can invite one back. */
async function assertNotLastOwner(
  tx: { <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  orgId: string,
  userId: string,
): Promise<void> {
  const rows = (await tx`
    select count(*)::int as remaining from users
    where org_id = ${orgId} and role = 'owner' and status = 'active' and id <> ${userId}`) as unknown as {
    remaining: number;
  }[];

  if ((rows[0]?.remaining ?? 0) === 0) {
    throw new AdminError('conflict', 'that would leave the organisation without an active owner');
  }
}

function toUser(row: Record<string, unknown>): UserRecord {
  return {
    id: row['id'] as string,
    orgId: row['org_id'] as string,
    orgName: row['org_name'] as string,
    email: String(row['email']),
    role: row['role'] as Role,
    status: row['status'] as UserStatus,
    emailVerifiedAt: date(row['email_verified_at']),
    lastLoginAt: date(row['last_login_at']),
    lockedUntil: date(row['locked_until']),
    sessions: Number(row['sessions'] ?? 0),
    createdAt: (row['created_at'] as Date).toISOString(),
  };
}

const date = (value: unknown): string | null => (value ? (value as Date).toISOString() : null);

/**
 * Makes an account staff, or takes it back.
 *
 * The bootstrap problem: staff are the only people who can create staff, and a fresh deployment has
 * none. So the first one is granted from the command line by whoever owns the database, which is
 * the only authority that exists before there are accounts. Any live invitation for the address is
 * updated too, so promoting someone who has not accepted yet still produces a staff account.
 */
export async function setStaff(
  sql: Sql,
  email: string,
  staff: boolean,
  actorId: string | null = null,
): Promise<UserRecord> {
  const normalized = email.trim().toLowerCase();

  const id = await withStaff(sql, async (tx) => {
    const [user] = await tx`select id, org_id, role from users where email = ${normalized}`;
    if (!user) throw new AdminError('not_found', `no account for ${normalized}`);

    const role = staff ? 'staff' : 'owner';
    if (!staff && user['role'] === 'owner') {
      // Demoting the only owner is the same hole as deleting them.
      await assertNotLastOwner(tx, user['org_id'] as string, user['id'] as string);
    }

    await tx`update users set role = ${role} where id = ${user['id']}`;
    await tx`
      update invitations set role = ${role}
      where email = ${normalized} and consumed_at is null and revoked_at is null`;

    await recordAudit(tx, {
      orgId: user['org_id'] as string,
      actorUserId: actorId,
      action: staff ? 'user.staff_granted' : 'user.staff_revoked',
      targetType: 'user',
      targetId: user['id'] as string,
      metadata: { email: normalized },
    });

    return user['id'] as string;
  });

  return getUser(sql, id);
}
