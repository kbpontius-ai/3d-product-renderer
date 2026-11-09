import type { Tx } from './client.js';

/**
 * Writing to the audit log.
 *
 * Lives with the schema rather than with any one feature because several packages have something to
 * record — staff administration, queue operations, pack publishing — and all of them must write the
 * entry inside the transaction that makes the change. An action that commits without its audit row
 * is exactly the action nobody wanted unrecorded.
 */

export interface AuditEntry {
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx`
    insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
    values (${entry.orgId}, ${entry.actorUserId}, ${entry.action}, ${entry.targetType ?? null},
            ${entry.targetId ?? null}, ${tx.json((entry.metadata ?? {}) as never)})`;
}
