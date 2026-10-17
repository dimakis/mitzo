import { dismissReviewedTelosSourcePermission } from '@mitzo/harness';
import type { PermissionRequest } from '@mitzo/protocol';
import { TelosSourceApprovalStore } from './telos-source-approval-store.js';

/** Replays only the authenticated operator's exact prepared saves. The new card
 * has no new approval deadline: it can only retry or dismiss old consent. */
export function createTelosSourcePermissionRecovery(dbPath: () => string) {
  return {
    list(sessionId: string, actorId: string): PermissionRequest[] {
      const store = new TelosSourceApprovalStore(dbPath());
      try {
        return store.recoveries(sessionId, 'operator:' + actorId).map((record) => ({
          permId: record.proof.permId,
          sessionId,
          toolName: record.proof.toolName,
          toolInput: JSON.stringify({
            operation: record.operation.kind,
            proposalSha256: record.input.proposalSha256,
          }),
          title: 'Recover this reviewed Telos save',
          reviewKind: 'telos_source' as const,
          recoveryOnly: true as const,
          approvalScope: 'request' as const,
        }));
      } finally {
        store.close();
      }
    },
    dismiss(permId: string, sessionId: string, actorId: string) {
      const store = new TelosSourceApprovalStore(dbPath());
      try {
        const record = store.lookup(permId, sessionId, 'operator:' + actorId);
        if (!record || !store.dismiss(permId, sessionId, 'operator:' + actorId)) return false;
        dismissReviewedTelosSourcePermission(record.proof);
        return true;
      } finally {
        store.close();
      }
    },
  };
}
