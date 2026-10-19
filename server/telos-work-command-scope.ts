import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { TaskStore } from './task-store.js';
import type { TelosWorkStore } from './telos-work-store.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { assertTelosWorkExecutionAuthority } from './telos-work-execution-authority.js';

interface Owners {
  events: Pick<EventStore, 'getSessionEvents' | 'getOrdinarySessionPreparationForConversation'>;
  tasks?: Pick<
    TaskStore,
    'getTelosExecutionBinding' | 'getTelosExecutionTaskForConversation'
  > | null;
  work(): Pick<TelosWorkStore, 'executionTaskBinding' | 'delegationAllocationForHost'>;
}

/** Infer command scope from durable owners, never caller task IDs or prompt text.
 * Legacy and standalone S4 chats keep their normal admission. A partially linked
 * S5 worker must recover provisioning explicitly before it can admit a command.
 * This read-only guard cannot repair work, enqueue a command or start a turn.
 */
export function resolveTelosWorkCommandScope(
  owners: Owners,
  sessionId: string,
  account: AccountBinding | undefined,
): { currentTaskId: string; goalId: string } | null {
  const selected = resolveTelosWorkRoleContext(owners.events, sessionId, account);
  // The ordinary allocator commits this marker atomically with the session.
  // A crash can precede role retention, so absence of role context is not proof
  // that a newly prepared conversation is an unrelated legacy chat.
  const prepared = owners.events.getOrdinarySessionPreparationForConversation(sessionId);
  const taskId = owners.tasks?.getTelosExecutionTaskForConversation(sessionId);
  if (prepared?.delegationAttemptId && (selected?.role !== 'worker' || !taskId))
    throw new Error('Delegated worker provisioning is incomplete; recover its original request');
  if (!taskId) {
    if (selected?.role !== 'worker') return null;
    if (
      selected.executionTaskId ||
      (prepared && owners.work().delegationAllocationForHost(prepared.allocationOperationId))
    )
      throw new Error('Delegated worker provisioning is incomplete; recover its original request');
    return null;
  }
  if (!owners.tasks || selected?.role !== 'worker')
    throw new Error('Durable delegated task requires its exact retained worker role');
  if (prepared?.delegationAttemptId) {
    const mapping = owners.tasks.getTelosExecutionBinding(taskId);
    if (
      !mapping ||
      mapping.attemptId !== prepared.delegationAttemptId ||
      prepared.sessionId !== sessionId
    )
      throw new Error('Delegated worker preparation does not match its exact task attempt');
    const attempt = owners.work().executionTaskBinding(taskId, sessionId);
    if (
      !attempt ||
      attempt.attemptId !== prepared.delegationAttemptId ||
      attempt.allocationReceiptId !== prepared.allocationOperationId
    )
      throw new Error(
        'Durable delegated worker allocation authority does not match its preparation',
      );
  }
  assertTelosWorkExecutionAuthority(
    { events: owners.events, tasks: owners.tasks, work: owners.work },
    sessionId,
    account,
    taskId,
  );
  return { currentTaskId: taskId, goalId: taskId };
}

/** Called for new queue admission and immediately before physical provider
 * dispatch. Do not use for tools/completion inside an already running turn. */
export function assertTelosWorkCommandAdmission(
  owners: Omit<Owners, 'work' | 'events'> & {
    /** Trusted native history for conversations predating dispatch events. */
    hasAcceptedProviderTurn?(sessionId: string, account: AccountBinding | undefined): boolean;
    events: Owners['events'] & Pick<EventStore, 'hasProviderDispatchForConversation'>;
    work(): Pick<
      TelosWorkStore,
      | 'executionTaskBinding'
      | 'delegationAllocationForHost'
      | 'assertExecutionBriefCurrent'
      | 'enforceControlAction'
    >;
  },
  sessionId: string,
  account: AccountBinding | undefined,
): void {
  const scope = resolveTelosWorkCommandScope(owners, sessionId, account);
  const selected = resolveTelosWorkRoleContext(owners.events, sessionId, account);
  if (!selected) return;
  owners.work().enforceControlAction(selected.itemId, 'safe_point', sessionId);
  if (
    scope &&
    !owners.events.hasProviderDispatchForConversation(sessionId) &&
    !owners.hasAcceptedProviderTurn?.(sessionId, account)
  )
    owners.work().enforceControlAction(selected.itemId, 'new_worker_dispatch', sessionId);
  if (scope) owners.work().assertExecutionBriefCurrent(scope.currentTaskId, sessionId);
}
