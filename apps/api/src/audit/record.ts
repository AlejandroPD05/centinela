import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/** Entrada del registro de auditoría; todo lo opcional queda nulo. */
export interface AuditEntry {
  userId?: string | null;
  workspaceId?: string | null;
  /** Verbo estable en snake_case: `auth.login`, `monitor.create`… */
  action: string;
  targetType?: string;
  targetId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Apunta una acción en el registro de auditoría. Es una escritura normal: si
 * falla, la acción que la provoca también falla (preferimos no perder rastro).
 */
export async function recordAudit(database: Database, entry: AuditEntry): Promise<void> {
  await database.insert(auditLog).values({
    userId: entry.userId ?? null,
    workspaceId: entry.workspaceId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    detail: entry.detail ?? null,
    ip: entry.ip ?? null,
  });
}
