import type { RepositoryWorkspace } from './repository-workspaces.js';
import { pendingHostTaskDecisionHash } from './pending-host-task.js';
import { PendingHostTaskDecisionSchema } from './pending-host-task.js';
import { isDeepStrictEqual } from 'node:util';

export const LOCAL_REPOSITORY_PREPARATION_TIMEOUT_MS = 300_000;

/** Only an unapproved selection or expired unconsumed approval, with no
 * materialization reservation, can be rebound. Qualification and approval run anew. */
export function canRenewRepositoryApproval(record: RepositoryWorkspace): boolean {
  if (
    !record.qualifiedLocalPreparation ||
    record.state !== 'ready' ||
    record.pendingHostTask ||
    record.retirement ||
    record.hostReservation ||
    record.conversationId ||
    record.directory ||
    record.taskIdentity ||
    record.sandbox ||
    record.sourceReleased ||
    record.ordinaryFirstReservation ||
    record.preparedRepositoryTransitionAdoption
  )
    return false;
  if (record.pendingHostTaskDecision) {
    const decision = PendingHostTaskDecisionSchema.safeParse(record.pendingHostTaskDecision);
    return (
      decision.success &&
      decision.data.state !== 'consumed' &&
      decision.data.evidence.expiresAt <= Date.now() &&
      isDeepStrictEqual(decision.data.request, record.qualifiedLocalPreparation.request)
    );
  }
  if (record.approvalExpiry)
    return (
      record.approvalExpiry.requestSha256 ===
      pendingHostTaskDecisionHash(record.qualifiedLocalPreparation.request)
    );
  // Older releases did not retain expiry. Wait past the original operation's
  // maximum lifetime and prove that no effect was admitted. Do not invent a
  // historical timeout cause; a new caller still needs fresh exact approval.
  return (
    Number.isFinite(record.createdAt) &&
    Date.now() >= record.createdAt + LOCAL_REPOSITORY_PREPARATION_TIMEOUT_MS
  );
}
