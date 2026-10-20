import type { AccountBinding } from '@mitzo/protocol';
import type { TaskStore } from './task-store.js';
import type { TelosWorkStore } from './telos-work-store.js';
import { assertTelosWorkTaskExecutionScope } from './telos-work-role-context.js';

interface ExecutionAuthorityOwners {
  events: Parameters<typeof assertTelosWorkTaskExecutionScope>[0];
  tasks: Pick<TaskStore, 'getTelosExecutionBinding'>;
  /** Lazy owner access: unbound ordinary tasks never open the Telos database. */
  work(): Pick<TelosWorkStore, 'executionTaskBinding'>;
}

/** Read-only host guard. Both durable owners and the immutable selected worker
 * context must agree. Incomplete provisioning requires an explicit host retry;
 * this guard never repairs a mapping or dispatches a turn.
 */
export function assertTelosWorkExecutionAuthority(
  owners: ExecutionAuthorityOwners,
  sessionId: string,
  accountBinding: AccountBinding | undefined,
  taskId: string,
): void {
  const mapping = owners.tasks.getTelosExecutionBinding(taskId);
  assertTelosWorkTaskExecutionScope(
    owners.events,
    sessionId,
    accountBinding,
    taskId,
    mapping ? { ...mapping, executionTaskId: taskId } : null,
  );
  if (!mapping) return;
  const attempt = owners.work().executionTaskBinding(taskId, sessionId);
  if (
    !attempt ||
    attempt.state !== 'chat_ready' ||
    !attempt.allocationReceiptId ||
    attempt.executionTaskId !== taskId ||
    attempt.attemptId !== mapping.attemptId ||
    attempt.childItemId !== mapping.childItemId ||
    attempt.leadConversationId !== mapping.leadConversationId ||
    attempt.workerConversationId !== mapping.workerConversationId ||
    attempt.workerConversationId !== sessionId ||
    attempt.contextSnapshotId !== mapping.contextSnapshotId
  )
    throw new Error('Durable Telos execution authority does not match the selected worker task');
}

/** HTTP task callbacks carry the original host-selected worker and task. A
 * mutable client key alone cannot authorize an effect on a rebound session. */
export function resolveTelosWorkTaskToolContext(
  owners: ExecutionAuthorityOwners,
  current: { sessionId: string; taskId: string; accountBinding: AccountBinding | undefined },
  expected: { sessionId: unknown; taskId: unknown },
): string | null {
  const mapped = owners.tasks.getTelosExecutionBinding(current.taskId);
  const pinned = expected.sessionId !== undefined || expected.taskId !== undefined;
  if (
    (mapped || pinned) &&
    (expected.sessionId !== current.sessionId || expected.taskId !== current.taskId)
  )
    return null;
  assertTelosWorkExecutionAuthority(
    owners,
    current.sessionId,
    current.accountBinding,
    current.taskId,
  );
  return current.taskId;
}
