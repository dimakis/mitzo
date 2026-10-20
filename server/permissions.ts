export {
  onPermissionLifecycle,
  registerPending,
  resolvePending,
  removePending,
  hasPending,
  isCompletePendingBashCommand,
  getPendingSessionId,
  denyPendingBySession,
  getPendingTelosSourceReview,
  resolveReviewedTelosSourcePermission,
} from '@mitzo/harness';
import { getPendingRequestsBySession as livePendingRequests } from '@mitzo/harness';
import type { PermissionRequest } from '@mitzo/protocol';
let sourceRecovery:
  | {
      list(sessionId: string, actorId: string): PermissionRequest[];
      dismiss(permId: string, sessionId: string, actorId: string): boolean;
    }
  | undefined;
export function configureTelosSourcePermissionRecovery(recovery: typeof sourceRecovery) {
  sourceRecovery = recovery;
}
export function getPendingRequestsBySession(
  sessionId: string,
  actorId?: string,
): PermissionRequest[] {
  const live = livePendingRequests(sessionId);
  if (!actorId || !sourceRecovery) return live;
  try {
    return [
      ...new Map(
        [...live, ...sourceRecovery.list(sessionId, actorId)].map((request) => [
          request.permId,
          request,
        ]),
      ).values(),
    ];
  } catch {
    return live;
  }
}
export function dismissTelosSourcePermissionRecovery(
  permId: string,
  sessionId: string,
  actorId: string,
): boolean {
  if (!sourceRecovery) return false;
  try {
    return sourceRecovery.dismiss(permId, sessionId, actorId);
  } catch {
    return false;
  }
}
