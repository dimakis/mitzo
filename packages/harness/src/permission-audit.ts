import { createLogger } from './logger.js';
const log = createLogger('permission-audit');
export interface PermissionAuditEvent {
  phase: 'requested' | 'resolved' | 'evaluated' | 'reused';
  time: number;
  sessionId?: string;
  permId?: string;
  toolName: string;
  toolUseID?: string;
  scopeHash?: string;
  approvalScope?: string;
  decision?: 'once' | 'always' | 'deny';
  outcome?: 'allowed' | 'denied' | 'expired' | 'cancelled' | 'failed';
  waitMs?: number;
}
const listeners = new Set<(event: PermissionAuditEvent) => void>();
export function onPermissionAudit(listener: (event: PermissionAuditEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Deliberate projection: arguments, questions, credentials and raw errors never
 * enter this diagnostic stream. Audit observers cannot grant or revoke access.
 */
export function recordPermissionAudit(event: PermissionAuditEvent): void {
  const safe: PermissionAuditEvent = {
    phase: event.phase,
    time: event.time,
    sessionId: event.sessionId,
    permId: event.permId,
    toolName: event.toolName,
    toolUseID: event.toolUseID,
    scopeHash: event.scopeHash,
    approvalScope: event.approvalScope,
    decision: event.decision,
    outcome: event.outcome,
    waitMs: event.waitMs,
  };
  log.info('Permission audit', { ...safe });
  for (const listener of listeners) {
    try {
      listener(structuredClone(safe));
    } catch (error) {
      log.error('Permission audit observer failed; decision authority is unchanged', {
        sessionId: safe.sessionId,
        permId: safe.permId,
        errorType: error instanceof Error ? error.name : 'non-Error',
      });
    }
  }
}
