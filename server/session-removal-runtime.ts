import { createHash } from 'node:crypto';
import type { SessionRegistry } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import type { TaskStore } from './task-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';

/** No new model turn is needed to close an idle owner. Active work is
 * interrupted by its original query; uncertain effects remain a blocker. */
export function createSessionRemovalRuntime(deps: {
  events: EventStore;
  registry: SessionRegistry;
  tasks: Pick<TaskStore, 'getTree' | 'getTelosExecutionBinding'>;
  native(): CodexConversationStore;
  stop(clientId: string): void;
}) {
  const meta = (id: string) => {
    const value = deps.events.getSession(id);
    if (
      !value?.accountBinding ||
      !value.cwd ||
      deps.events.getSessionRuntimeBinding(id)?.version !== 2
    )
      throw Error(
        'Runtime ownership is unavailable. Archive this chat or review its original owner.',
      );
    return value;
  };
  const assertProtected = (id: string) => {
    const value = meta(id);
    if (
      value.sessionType === 'symposium' ||
      value.symposiumConfig ||
      deps.events
        .getEventsOfType(id, 'workspace_retention')
        .some((event) => event.payload.policy === 'external-owner')
    )
      throw Error('This chat has shared or external custody. Review its owner before removal.');
    const live = deps.registry.findBySessionId(id);
    const clients = new Map(
      [...deps.registry.entries()].map(([clientId, session]) => [clientId, session.sessionId]),
    );
    const check = (tasks: ReturnType<TaskStore['getTree']>): boolean =>
      tasks.some((task) => {
        if (['done', 'skipped', 'failed'].includes(task.status)) return check(task.children);
        return (
          task.sessionId === id ||
          (live && task.sessionId === live.clientId) ||
          (task.sessionId && clients.get(task.sessionId) === id) ||
          deps.tasks.getTelosExecutionBinding(task.id)?.workerConversationId === id ||
          check(task.children)
        );
      });
    if (check(deps.tasks.getTree()))
      throw Error('Task Board work still owns this chat. Settle it before removal.');
  };
  /** The ordinary owner journals admission before bootstrap/provider effects.
   * An exact silent preparation can therefore be removed without inventing a
   * native conversation, while the durable removal fence prevents admission. */
  const assertNeverStartedPreparation = (id: string) => {
    const value = meta(id);
    const binding = deps.events.getSessionRuntimeBinding(id)!;
    const preparation = deps.events.getOrdinaryWorkspaceSessionPreparationForConversation(id);
    if (
      binding.harness.implementation !== 'codex' ||
      binding.execution.location !== 'local' ||
      !value.ordinaryWorkspaceId ||
      value.repositoryWorkspaceId != null ||
      !preparation ||
      preparation.sessionId !== id ||
      preparation.workspaceId !== value.ordinaryWorkspaceId ||
      preparation.firstCommandId !== null ||
      value.executionPhase != null ||
      deps.events.getOrdinaryInitialCommandId(id) ||
      deps.events.getLatestOrdinaryCommandAdmission(id) ||
      deps.events.hasUncertainOrdinaryCommand(id) ||
      deps.events.hasRecentSendCommandForSession(id, 0) ||
      deps.registry.findBySessionId(id) ||
      !deps.events.removals.read(id)
    )
      throw Error(
        'Native runtime absence is not proof of an unused ordinary preparation. Preserve this chat and review its original startup.',
      );
    deps.events.assertPreparedOrdinaryWorkspaceSession(
      preparation.allocationOperationId,
      {
        sessionId: id,
        ordinaryWorkspaceId: value.ordinaryWorkspaceId,
        cwd: value.cwd!,
        accountBinding: value.accountBinding!,
        agentProfile: value.agentProfile ?? undefined,
        agentContext: value.agentContext ?? undefined,
        selectedModel: value.selectedModel ?? undefined,
        reasoningEffort: value.reasoningEffort ?? undefined,
        mode: value.mode ?? undefined,
      },
      binding,
      preparation.settings.selection,
    );
  };
  const assertSettled = (id: string) => {
    assertProtected(id);
    const value = meta(id),
      binding = deps.events.getSessionRuntimeBinding(id)!;
    if (
      deps.registry.findBySessionId(id) ||
      (value.executionPhase && value.executionPhase !== 'TERMINAL') ||
      deps.events.hasUncertainOrdinaryCommand(id)
    )
      throw Error(
        'Runtime shutdown is unverified. Keep the chat and reconcile its unfinished work.',
      );
    if (binding.harness.implementation === 'codex') {
      const native = deps.native();
      if (!native.hasConversation(id)) assertNeverStartedPreparation(id);
      else
        native.assertRepositoryTaskStopped({
          conversationId: id,
          directory: value.cwd!,
          binding: value.accountBinding!,
        } as Parameters<CodexConversationStore['assertRepositoryTaskStopped']>[0]);
    } else if (
      binding.harness.implementation !== 'claude-sdk' ||
      deps.events.getPendingOrdinaryLocalVertexCommandIds(id).length
    )
      throw Error('Queued work remains. Keep the chat and review its original runtime.');
  };
  return {
    assertProtected,
    assertSettled,
    fingerprint(id: string) {
      const value = meta(id);
      return createHash('sha256')
        .update(
          JSON.stringify({
            id,
            cwd: value.cwd,
            account: value.accountBinding,
            runtime: deps.events.getSessionRuntimeBinding(id),
            workspace: value.repositoryWorkspaceId,
            ordinary: value.ordinaryWorkspaceId,
          }),
        )
        .digest('hex');
    },
    async closeRuntime(id: string) {
      assertProtected(id);
      const value = meta(id),
        binding = deps.events.getSessionRuntimeBinding(id)!;
      const startup = deps.registry.abortStartup(id);
      // Cancellation and all dispatch checks share the existing durable owners.
      if (binding.harness.implementation === 'codex') {
        const native = deps.native();
        if (!native.hasConversation(id)) {
          if (!startup) assertNeverStartedPreparation(id);
        } else
          for (const command of native.commands(id, value.accountBinding!))
            if (command.status === 'queued')
              native.cancelQueued(id, value.accountBinding!, command.id);
      } else if (binding.harness.implementation === 'claude-sdk')
        for (const commandId of deps.events.getPendingOrdinaryLocalVertexCommandIds(id))
          deps.events.cancelOrdinaryLocalVertexQueuedCommand(id, commandId);
      else throw Error('This runtime requires its original shutdown owner.');
      const live = deps.registry.findBySessionId(id);
      if (live) {
        deps.registry.markUserClose(live.clientId);
        try {
          if (live.session.turnInProgress) await live.session.queryInstance?.interrupt();
        } finally {
          try {
            live.session.ordinaryRuntimeOwner?.close();
          } finally {
            deps.stop(live.clientId);
          }
        }
      }
      if (startup)
        throw Error('Startup was cancelled. Review its final cleanup before removing the chat.');
      assertSettled(id);
      deps.events.upsertSession({ sessionId: id, isActive: false, closedBy: 'user' });
    },
  };
}
