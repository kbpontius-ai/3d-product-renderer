import { withStaff, type AuditEntry, type Sql } from '@pr/db';

/**
 * The audit log (F-AUTH-11, and the reason staff are allowed to cross tenants at all).
 *
 * Staff can read and change any organisation's rows, which is a power that only stays acceptable
 * while every use of it is recorded. Writing the entry inside the caller's transaction is
 * deliberate: an action that commits without its audit row would be exactly the action nobody
 * wanted unrecorded.
 */

export interface AuditRecord extends AuditEntry {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  targetEmail: string | null;
  metadata: Record<string, unknown>;
}

export async function listAudit(
  sql: Sql,
  options: { orgId?: string; limit?: number; offset?: number } = {},
): Promise<AuditRecord[]> {
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select a.*, actor.email as actor_email, subject.email as target_email
      from audit_log a
      left join users actor on actor.id = a.actor_user_id
      left join users subject on a.target_type = 'user' and a.target_id = subject.id::text
      where (${options.orgId ?? null}::uuid is null or a.org_id = ${options.orgId ?? null})
      order by a.created_at desc, a.id desc
      limit ${options.limit ?? 100} offset ${options.offset ?? 0}`;

    return rows.map((row) => ({
      actorEmail: row['actor_email'] ? String(row['actor_email']) : null,
      targetEmail: row['target_email'] ? String(row['target_email']) : null,
      id: String(row['id']),
      orgId: (row['org_id'] as string | null) ?? null,
      actorUserId: (row['actor_user_id'] as string | null) ?? null,
      action: row['action'] as string,
      targetType: (row['target_type'] as string | null) ?? undefined,
      targetId: (row['target_id'] as string | null) ?? undefined,
      metadata: row['metadata'] as Record<string, unknown>,
      createdAt: (row['created_at'] as Date).toISOString(),
    }));
  });
}

export async function countAudit(sql: Sql, orgId: string): Promise<number> {
  return withStaff(sql, async (tx) => {
    const [row] = await tx`select count(*)::int as total from audit_log where org_id = ${orgId}`;
    return Number(row?.['total'] ?? 0);
  });
}
