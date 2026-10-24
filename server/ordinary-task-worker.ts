import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { SessionTransport } from '@mitzo/harness';
import { CollaborationSettingsSchema, OrdinaryWorkspaceSettingsSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { TaskStore } from './task-store.js';
import type { TaskWorkerSession } from './task-orchestrator.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type { ManagedSession } from './session-registry.js';
import {
  captureAgentLibraryAuthorization,
  withAgentLibraryRecoveryAuthorization,
} from './agent-library-transport.js';
import { retainAgentContextAuthority } from './agent-context-authority.js';
import { ordinaryRepositoryRuntimeInventory } from './ordinary-local-codex-entry.js';
import { nativeStartupSessionId } from './ordinary-repository-startup.js';
import { dispatchOwnedOrdinaryCommand } from './ordinary-scoped-command.js';
import { latestTaskWorkerMarker, retainTaskWorkerAllocation } from './task-worker-authority.js';

interface WorkerDependencies {
  events: EventStore;
  tasks: TaskStore;
  workspaces: RepositoryWorkspaces;
  source(
    clientId: string,
  ):
    | Pick<ManagedSession, 'sessionId' | 'ownerConnectionId' | 'accountBinding' | 'mode' | 'model'>
    | undefined;
  /** Resolve the exact live owner after browser transport keys change. */
  sourceForSession?(sessionId: string): ReturnType<WorkerDependencies['source']>;
  taskRoot(): string;
  stop?(clientId: string, conversationId?: string): void;
}

/** Bind one workflow run to the selected existing ordinary conversation. The
 * TaskOrchestrator keeps scheduling; existing workspace and native admission
 * owners keep allocation, account custody, FIFO, cancellation and uncertainty.
 */
export function bindOrdinaryTaskWorkerSession(
  deps: WorkerDependencies,
  sourceClientId: string,
): TaskWorkerSession {
  const source = deps.source(sourceClientId);
  const sourceId = source?.sessionId;
  const sourceConnectionId = source?.ownerConnectionId;
  if (!sourceId || !sourceConnectionId)
    throw Error('Select an active ordinary source conversation for workers');
  const authorization = captureAgentLibraryAuthorization(sourceConnectionId);
  authorization.assertCurrent();
  const sourceMeta = deps.events.getSession(sourceId);
  const raw =
    deps.events.getOrdinaryWorkspaceConversationSettings(sourceId) ??
    deps.events.getOrdinaryConversationSettings(sourceId);
  if (!sourceMeta?.accountBinding || !sourceMeta.agentProfile || !raw)
    throw Error('Selected conversation has no retained ordinary worker settings');
  const settings =
    'workspace' in raw
      ? OrdinaryWorkspaceSettingsSchema.parse(raw)
      : CollaborationSettingsSchema.parse(raw);
  const sourceSettings = structuredClone(settings);
  const originalAccount = structuredClone(sourceMeta.accountBinding);
  const profile = structuredClone(sourceMeta.agentProfile);
  if (
    sourceMeta.isHidden ||
    sourceMeta.sessionType === 'symposium' ||
    sourceMeta.conversationSource === 'external_import' ||
    settings.binding.harness.implementation !== 'codex' ||
    settings.binding.execution.location !== 'local' ||
    !['openai', 'openai-codex'].includes(settings.binding.account.provider) ||
    settings.selection.context.source !== 'none' ||
    profile.definition.contextRecipe !== undefined ||
    sourceMeta.selectedModel !== settings.selection.model ||
    (sourceMeta.reasoningEffort ?? null) !== settings.selection.thinking ||
    sourceMeta.mode !== settings.selection.permission.mode
  )
    throw Error(
      'Selected source does not support independent ordinary workers with these execution choices',
    );
  const sourceSnapshot = () => {
    const meta = deps.events.getSession(sourceId);
    return {
      settings:
        deps.events.getOrdinaryWorkspaceConversationSettings(sourceId) ??
        deps.events.getOrdinaryConversationSettings(sourceId),
      binding: deps.events.getSessionRuntimeBinding(sourceId),
      account: meta?.accountBinding,
      profile: meta?.agentProfile,
      model: meta?.selectedModel,
      thinking: meta?.reasoningEffort ?? null,
      mode: meta?.mode,
      ordinaryWorkspaceId: meta?.ordinaryWorkspaceId,
      repositoryWorkspaceId: meta?.repositoryWorkspaceId,
      hidden: meta?.isHidden,
    };
  };
  const original = structuredClone(sourceSnapshot());
  const runController = new AbortController();
  const runAuthority = retainAgentContextAuthority({ ...authorization.auth }, runController);
  const close = () => {
    try {
      runController.abort(Error('Worker run authority closed'));
    } finally {
      runAuthority.release();
    }
  };
  const assertCurrent = () => {
    try {
      runAuthority.assertCurrent();
    } catch (error) {
      close();
      throw error;
    }
    if (
      (deps.sourceForSession ? deps.sourceForSession(sourceId) : deps.source(sourceClientId)) !==
        source ||
      !isDeepStrictEqual(sourceSnapshot(), original) ||
      !isDeepStrictEqual(original.binding, sourceSettings.binding)
    ) {
      close();
      throw Error('Selected worker source changed');
    }
  };
  try {
    assertCurrent();
  } catch (error) {
    close();
    throw error;
  }

  const spawn: TaskWorkerSession = async (taskId, prompt, goalId, onEnded, scope) => {
    assertCurrent();
    scope.signal.throwIfAborted();
    const signal = AbortSignal.any([scope.signal, runController.signal]);
    const clientId = `task-worker:${scope.operationId}`;
    let dispatched = false;
    let attempted = false;
    let workerConversationId: string | undefined;
    const cancel = () => {
      if (attempted) deps.stop?.(clientId, workerConversationId);
    };
    signal.addEventListener('abort', cancel, { once: true });
    const taskCurrent = () => {
      signal.throwIfAborted();
      assertCurrent();
      const task = deps.tasks.get(taskId);
      if (
        !task ||
        task.status !== 'active' ||
        latestTaskWorkerMarker(task.annotations, 'allocation') !== scope.operationId
      )
        throw Error('Exact active worker allocation required');
    };
    try {
      return await withAgentLibraryRecoveryAuthorization(
        authorization.auth,
        async (operatorConnectionId) => {
          if (!operatorConnectionId) throw Error('Original worker operator required');
          taskCurrent();
          const inventory = ordinaryRepositoryRuntimeInventory('local', 'codex');
          const runtime = {
            account: sourceSettings.binding.account,
            harness: 'codex' as const,
            targetId: sourceSettings.binding.execution.targetId,
            mode: sourceSettings.selection.permission.mode,
          };
          const resolved = inventory.catalog.resolve(runtime);
          if (
            resolved.status !== 'compatible' ||
            !isDeepStrictEqual(resolved.binding, sourceSettings.binding)
          )
            throw Error('Selected worker runtime unavailable');
          const binding = inventory.profiles.resolve(
            runtime.account.accountId,
            sourceSettings.selection.model,
          );
          inventory.profiles.validateModelSelection(
            binding,
            sourceSettings.selection.model,
            sourceSettings.selection.thinking,
          );
          if (
            !isDeepStrictEqual(binding, {
              ...originalAccount,
              model: sourceSettings.selection.model,
            })
          )
            throw Error('Selected worker account changed');
          const selection = {
            ...structuredClone(sourceSettings.selection),
            permission: { mode: sourceSettings.selection.permission.mode, revision: 0 },
          };
          let sessionId: string;
          let reservation: Parameters<typeof dispatchOwnedOrdinaryCommand>[0]['reservation'];
          let preparationOperationId: string | undefined;
          let workspaceKind: 'ordinary' | 'repository';
          if ('workspace' in sourceSettings) {
            workspaceKind = 'ordinary';
            const retained = deps.workspaces.getOrdinaryWorkspaceForOperation(scope.operationId);
            // A source can have changed its supported per-turn model. Its
            // original preparation remains creation-time evidence; qualify the
            // independent child against the current explicit selection instead.
            const fresh = retained
              ? undefined
              : await deps.workspaces.prepareOrdinaryWorkspace({
                  binding,
                  selection: {
                    runOn: 'local',
                    runtime: {
                      account: runtime.account,
                      harness: 'codex',
                      targetId: runtime.targetId,
                    },
                  },
                  signal,
                });
            taskCurrent();
            if (fresh && !isDeepStrictEqual(fresh.runtimeBinding, sourceSettings.binding))
              throw Error('Original worker runtime target required');
            const workerSettings = OrdinaryWorkspaceSettingsSchema.parse({
              ...sourceSettings,
              selection,
              workspace: {
                kind: 'ordinary',
                preparationId: retained?.preparationId ?? fresh!.preparationId,
              },
            });
            const record =
              retained ??
              (await deps.workspaces.reserveOrdinaryWorkspace({
                preparationId: workerSettings.workspace.preparationId,
                allocationOperationId: scope.operationId,
                binding,
                settings: workerSettings,
                agentProfile: profile,
                taskRoot: deps.taskRoot(),
                signal,
                requiredCapabilities: [
                  'ordinary_conversation',
                  'retained_artifacts',
                  'task_execution',
                ],
              }));
            taskCurrent();
            if (
              !isDeepStrictEqual(record.settings, workerSettings) ||
              !isDeepStrictEqual(record.binding, binding)
            )
              throw Error('Original worker workspace settings required');
            if (!deps.events.getOrdinaryWorkspaceSessionPreparation(scope.operationId))
              deps.events.prepareOrdinaryWorkspaceSession(
                {
                  sessionId: record.conversationId,
                  ordinaryWorkspaceId: record.id,
                  cwd: record.directory,
                  accountBinding: binding,
                  agentProfile: profile,
                  selectedModel: selection.model,
                  reasoningEffort: selection.thinking,
                  mode: selection.permission.mode,
                },
                {
                  allocationOperationId: scope.operationId,
                  preparationFingerprint: record.preparationFingerprint,
                  settings: workerSettings,
                },
              );
            sessionId = record.conversationId;
            preparationOperationId = scope.operationId;
            reservation = {
              id: record.id,
              binding,
              conversationId: sessionId,
              taskRoot: record.hostReservation.taskRoot,
              commandFingerprint: record.preparationFingerprint,
              runtimeBinding: workerSettings.binding,
            };
          } else {
            workspaceKind = 'repository';
            const sourceWorkspace = deps.workspaces.get(sourceSettings.repositoryWorkspaceId);
            // Existing Mac sources are selected through their original repository
            // owner. Their dirty/staged/untracked work is never copied or reset.
            if (sourceWorkspace.localSource) {
              await deps.workspaces.selectExistingLocalRepository(
                binding,
                sourceWorkspace.localSource.path,
                {
                  runOn: 'local',
                  runtime: {
                    account: runtime.account,
                    harness: 'codex',
                    targetId: runtime.targetId,
                  },
                },
                signal,
                scope.operationId,
                sourceWorkspace.baseOid,
              );
            } else {
              await deps.workspaces.prepareDelegatedWorkspace({
                allocationOperationId: scope.operationId,
                sourceConversationId: sourceId,
                settings: sourceSettings,
                binding,
                signal,
              });
            }
            taskCurrent();
            sessionId = nativeStartupSessionId(`repository:${scope.operationId}`);
            reservation = {
              id: scope.operationId,
              binding,
              conversationId: sessionId,
              taskRoot: deps.taskRoot(),
              runtimeBinding: sourceSettings.binding,
              commandFingerprint: createHash('sha256')
                .update(
                  JSON.stringify({
                    sourceId,
                    sourceSettings,
                    operationId: scope.operationId,
                    taskId,
                    goalId,
                    prompt,
                  }),
                )
                .digest('hex'),
            };
            await deps.workspaces.reserveHostTask({ ...reservation, signal });
          }
          taskCurrent();
          deps.tasks.setSessionId(taskId, clientId);
          const task = deps.tasks.get(taskId)!;
          deps.tasks.update(taskId, {
            annotations: [...task.annotations, `worker_conversation: ${sessionId}`],
          });
          const commandId = `worker-command:${scope.operationId}`;
          const command = {
            clientMsgId: commandId,
            capabilityRevision: inventory.result.capabilityRevision,
            runtime,
            selection,
            payload: { text: prompt },
          };
          const transport: SessionTransport = { isOpen: () => !signal.aborted, send() {} };
          workerConversationId = sessionId;
          attempted = true;
          const result = await dispatchOwnedOrdinaryCommand({
            transport,
            clientId,
            sessionId,
            commandId,
            command,
            reservation,
            operatorConnectionId,
            ownerConnectionId: sourceConnectionId,
            ownerAuthSessionId: authorization.auth.id,
            signal,
            continuation: false,
            existingOwner: false,
            workspaceKind,
            preparationOperationId,
            onSessionPrepared(session) {
              taskCurrent();
              retainTaskWorkerAllocation(deps.events, {
                version: 1,
                taskId,
                goalId,
                operationId: scope.operationId,
                workerClientId: clientId,
                conversationId: sessionId,
              });
              session.taskContext = {
                currentTaskId: taskId,
                goalId,
                workerAllocationId: scope.operationId,
              };
            },
            onTerminalOutcome(error) {
              if (error) onEnded(clientId, error);
            },
            onEnded() {
              signal.removeEventListener('abort', cancel);
              onEnded(clientId);
            },
          });
          dispatched = result.dispatched;
          if (!dispatched)
            throw Error(
              'Worker command retained without confirmed live dispatch; inspect its conversation before retrying',
            );
          if (signal.aborted) {
            cancel();
            signal.throwIfAborted();
          }
          return clientId;
        },
      );
    } finally {
      if (!attempted) signal.removeEventListener('abort', cancel);
    }
  };
  spawn.close = close;
  return spawn;
}
