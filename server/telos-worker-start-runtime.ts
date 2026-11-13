import { isDeepStrictEqual } from 'node:util';
import { checkSkillPolicy } from '@mitzo/harness';
import type {
  CollaborationSettings,
  OrdinaryWorkspaceSettings,
  TelosWorkDelegationReceipt,
} from '@mitzo/protocol';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import {
  sessionToolOperatorConnection,
  retainedNativeHostToolOperator,
} from './native-host-tool-operator.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { createTelosWorkerStarter, type TelosWorkerStartAuthority } from './telos-worker-start.js';
import { TelosWorkStore } from './telos-work-store.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import type { TelosWorkRoleRequest } from './telos-work-routes.js';
import type { TaskStore } from './task-store.js';
import { captureTelosWorkerFirstCommandAuthority } from './telos-worker-start-authority.js';

/** The signed source owner is supplied by the live runtime, never tool JSON. */
export async function startAllocatedTelosWorker(
  request: TelosWorkRoleRequest,
  allocation: TelosWorkDelegationReceipt,
  deps: {
    dbPath(): string;
    tasks: TaskStore;
    qualify(
      settings: CollaborationSettings | OrdinaryWorkspaceSettings,
      workerId: string,
      authority: TelosWorkerStartAuthority,
    ): ReturnType<Parameters<typeof createTelosWorkerStarter>[0]['qualify']>;
  },
) {
  const { eventStore, registry } = await import('./chat.js');
  const { getCodexConversationStore } = await import('./codex-chat-session.js');
  const { getOrdinaryWorkspaces, getRepositoryWorkspaces } =
    await import('./repository-workspace-runtime.js');
  const { dispatchOwnedOrdinaryCommand } = await import('./ordinary-scoped-command.js');
  if (request.actor.kind !== 'conversation')
    throw Error('An exact current ordinary lead must request execution');
  const sourceId = request.actor.id;
  const source = registry.findBySessionId(sourceId);
  if (!source?.session.ordinaryRuntimeOwner)
    throw Error('Original live lead runtime owner required');
  const driver = source.session.ordinaryRuntimeOwner;
  const operatorConnectionId = sessionToolOperatorConnection(source.session, source.clientId);
  const captured = captureAgentLibraryAuthorization(operatorConnectionId);
  const signal = AbortSignal.any([request.signal, source.session.abortController.signal]);
  const assertSourceCurrent = () => {
    source.session.abortController.signal.throwIfAborted();
    captured.assertCurrent();
    const now = registry.findBySessionId(sourceId);
    if (
      now?.session !== source.session ||
      now.clientId !== source.clientId ||
      now.session.ordinaryRuntimeOwner !== driver ||
      driver.authSessionId !== captured.auth.id ||
      sessionToolOperatorConnection(now.session, now.clientId) !== operatorConnectionId ||
      registry.isClosingOut(source.clientId) ||
      registry.isUserClose(source.clientId) ||
      !agentToolAllowed(now.session, 'TelosStartSlice') ||
      checkSkillPolicy(registry, source.clientId, 'TelosStartSlice') === 'deny'
    )
      throw Error('Original signed Telos lead authority changed');
  };
  const authority: TelosWorkerStartAuthority = {
    sourceConversationId: sourceId,
    operatorConnectionId,
    authSessionId: captured.auth.id,
    signal,
    assertCurrent() {
      request.assertAuthorized();
      signal.throwIfAborted();
      assertSourceCurrent();
    },
  };
  authority.assertCurrent();
  const tasks = deps.tasks;
  const work = new TelosWorkStore(deps.dbPath(), {
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(eventStore.getSession(id)),
  });
  try {
    const native = getCodexConversationStore();
    const starter = createTelosWorkerStarter({
      events: eventStore,
      tasks,
      work,
      workspaces: eventStore.getSession(allocation.workerConversationId)?.ordinaryWorkspaceId
        ? getOrdinaryWorkspaces()
        : getRepositoryWorkspaces(),
      occupied: (id) => Boolean(registry.findBySessionId(id)),
      hasNativeConversation: (id) => native.hasConversation(id),
      accepted: (id, binding, commandId) =>
        Boolean(native.acceptedProviderTurnForCommand(id, binding, commandId)),
      qualify: async (settings, workerId) => {
        if (
          settings.binding.execution.location !== 'local' ||
          settings.binding.harness.implementation !== 'codex' ||
          settings.binding.account.provider !== 'openai-codex'
        )
          throw Error(
            'Delegated worker startup currently requires its selected Local Mac Codex runtime',
          );
        const selected = await deps.qualify(settings, workerId, authority);
        authority.assertCurrent();
        if (!isDeepStrictEqual(selected.binding, eventStore.getSession(workerId)?.accountBinding))
          throw Error('Original worker account changed');
        return selected;
      },
      dispatch: (input) =>
        dispatchOwnedOrdinaryCommand({
          ...input,
          firstCommandAuthority: captureTelosWorkerFirstCommandAuthority({
            commandId: input.commandId,
            allocation,
            events: eventStore,
            databasePath: deps.dbPath,
            assertSourceCurrent,
          }),
          onSessionPrepared(session) {
            authority.assertCurrent();
            const retained = retainedNativeHostToolOperator(session);
            if (!retained) throw Error('Original worker operator was not retained');
            session.ownerConnectionId = retained;
          },
        }),
    });
    return await starter(allocation, authority);
  } finally {
    work.close();
  }
}
