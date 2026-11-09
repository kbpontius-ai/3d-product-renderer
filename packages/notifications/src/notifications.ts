import { uuidv7, withStaff, withTenant, type Sql, type TenantContext, type Tx } from '@pr/db';

/**
 * Telling someone something happened while they were elsewhere (F-REND-08).
 *
 * Deliberately a table rather than a push channel: a render finishes minutes after the tab that
 * asked for it may have closed, and a message that only exists in a websocket frame is a message
 * nobody gets. The bell reads rows; anything live is an optimisation on top of them.
 */

export type NotificationKind = 'render.succeeded' | 'render.failed' | 'render.canceled';

export interface NotificationInput {
  orgId: string;
  /** The person to tell. Null addresses the whole organisation, which is rarely what you want. */
  userId: string | null;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** Writes the row inside a transaction the caller already has open. */
export async function recordNotification(tx: Tx, input: NotificationInput): Promise<string> {
  const id = uuidv7();
  await tx`
    insert into notifications (id, org_id, user_id, kind, title, body, link, metadata)
    values (${id}, ${input.orgId}, ${input.userId}, ${input.kind}, ${input.title},
            ${input.body ?? null}, ${input.link ?? null}, ${tx.json((input.metadata ?? {}) as never)})`;
  return id;
}

/**
 * Writes one from outside a transaction, as a worker does.
 *
 * Staff context because the worker serves every organisation and has no session of its own; the row
 * it writes names the organisation the job belonged to.
 */
export async function notify(sql: Sql, input: NotificationInput): Promise<string> {
  return withStaff(sql, (tx) => recordNotification(tx, input));
}

export async function listNotifications(
  sql: Sql,
  ctx: TenantContext,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRecord[]> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx`
      select * from notifications
      where (user_id = ${ctx.userId} or user_id is null)
        and (${options.unreadOnly ?? false} = false or read_at is null)
      order by created_at desc
      limit ${options.limit ?? 30}`;

    return rows.map(toRecord);
  });
}

export async function unreadCount(sql: Sql, ctx: TenantContext): Promise<number> {
  return withTenant(sql, ctx, async (tx) => {
    const [row] = await tx`
      select count(*)::int as n from notifications
      where (user_id = ${ctx.userId} or user_id is null) and read_at is null`;
    return Number(row?.['n'] ?? 0);
  });
}

/** Marks the named notifications read, or every one of this user's when given no ids. */
export async function markRead(sql: Sql, ctx: TenantContext, ids?: string[]): Promise<number> {
  return withTenant(sql, ctx, async (tx) => {
    const rows =
      ids && ids.length > 0
        ? await tx`
            update notifications set read_at = now()
            where read_at is null and id = any(${ids})
              and (user_id = ${ctx.userId} or user_id is null)
            returning id`
        : await tx`
            update notifications set read_at = now()
            where read_at is null and (user_id = ${ctx.userId} or user_id is null)
            returning id`;
    return rows.length;
  });
}

function toRecord(row: Record<string, unknown>): NotificationRecord {
  return {
    id: row['id'] as string,
    kind: row['kind'] as NotificationKind,
    title: row['title'] as string,
    body: (row['body'] as string | null) ?? null,
    link: (row['link'] as string | null) ?? null,
    metadata: row['metadata'] as Record<string, unknown>,
    readAt: row['read_at'] ? (row['read_at'] as Date).toISOString() : null,
    createdAt: (row['created_at'] as Date).toISOString(),
  };
}
