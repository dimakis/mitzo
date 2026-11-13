import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  TelosWorkDelegationReceiptSchema,
  type TelosWorkDelegationReceipt,
  type TelosSliceExecutionReceipt,
  type AccountBinding,
  type AgentLibraryVersion,
  type CollaborationSettings,
  type OrdinaryWorkspaceSettings,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { TaskStore } from './task-store.js';
import type { TelosWorkStore } from './telos-work-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type { OwnedOrdinaryDispatchInput } from './ordinary-scoped-command.js';
import {
  assertTelosWorkCommandAdmission,
  resolveTelosWorkCommandScope,
} from './telos-work-command-scope.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { NullTransport } from './null-transport.js';
import { createLogger } from './logger.js';
import { retainTelosDiagnosticFailure } from './telos-operation-failure.js';

const log = createLogger('telos-worker-start');
const starts = new WeakMap<EventStore, Map<string, Promise<TelosSliceExecutionReceipt>>>();
const failures = new WeakMap<EventStore, Map<string, unknown>>();
export const telosWorkerStartFailure = (events: EventStore, commandId: string) =>
  failures.get(events)?.get(commandId);
const prompt =
  'Begin your assigned Telos slice using its retained reviewed brief. Read the current item and evidence notes before acting. Execute only that slice, respect its dependencies and permissions, and report only actionable blockers, shared interface decisions and completion evidence to its lead. Do not create replacement workers or start siblings.';

export interface TelosWorkerStartAuthority {
  sourceConversationId: string;
  operatorConnectionId: string;
  authSessionId: string;
  signal: AbortSignal;
  assertCurrent(): void;
}
interface Dependencies {
  events: EventStore;
  work: TelosWorkStore;
  tasks: TaskStore;
  workspaces: RepositoryWorkspaces;
  qualify(
    settings: CollaborationSettings | OrdinaryWorkspaceSettings,
    workerId: string,
    signal: AbortSignal,
  ): Promise<{
    binding: AccountBinding;
    agentProfile: AgentLibraryVersion;
    taskRoot: string;
    capabilityRevision: string;
    sandboxWorkdir?: string;
  }>;
  occupied(workerId: string): boolean;
  hasNativeConversation(workerId: string): boolean;
  accepted(workerId: string, account: AccountBinding, commandId: string): boolean;
  dispatch(input: OwnedOrdinaryDispatchInput): Promise<unknown>;
}

/** Explicit exact-lead first-command adapter. Allocation, model selection and
 * retries stay with their original owners. No cold peer-message recovery. */
export function createTelosWorkerStarter(deps: Dependencies) {
  return async (
    raw: TelosWorkDelegationReceipt,
    authority: TelosWorkerStartAuthority,
  ): Promise<TelosSliceExecutionReceipt> => {
    const allocation = TelosWorkDelegationReceiptSchema.parse(structuredClone(raw));
    const { workerConversationId: workerId, attempt } = allocation;
    // Stable across aliases, lost HTTP replies and process restart. A new tool
    // request cannot turn the same allocation into a second first command.
    const commandId = createHash('sha256')
      .update(`telos-worker-first-command-v1:${attempt.attemptId}`)
      .digest('hex');
    const current = () => {
      authority.signal.throwIfAborted();
      authority.assertCurrent();
      if (
        !authority.authSessionId ||
        !authority.operatorConnectionId ||
        authority.sourceConversationId !== attempt.leadConversationId
      )
        throw Error('Exact signed originating lead required for worker startup');
      const source = deps.events.getSession(authority.sourceConversationId);
      const role = resolveTelosWorkRoleContext(
        deps.events,
        authority.sourceConversationId,
        source?.accountBinding ?? undefined,
      );
      if (role?.role !== 'lead') throw Error('Current retained lead role required');
      deps.work.readDelegationTarget(
        authority.sourceConversationId,
        attempt.childItemId,
        role.itemId,
      );
      const bound = deps.work.executionTaskBinding(attempt.executionTaskId!, workerId, true);
      if (!bound || !isDeepStrictEqual(bound, attempt))
        throw Error('Original allocated worker attempt required');
      const meta = deps.events.getSession(workerId);
      if (!isAvailableTelosWorkConversation(meta) || !meta?.accountBinding)
        throw Error('Original available worker required');
      deps.events.removals.assertAdmissible(workerId);
      const scope = resolveTelosWorkCommandScope(
        { events: deps.events, tasks: deps.tasks, work: () => deps.work },
        workerId,
        meta.accountBinding,
      );
      if (scope?.currentTaskId !== attempt.executionTaskId)
        throw Error('Original worker task binding required');
      return meta;
    };
    current();
    let running = starts.get(deps.events);
    if (!running) starts.set(deps.events, (running = new Map()));
    const pending = running.get(commandId);
    if (pending) {
      await pending;
      current();
    }
    const run = async (): Promise<TelosSliceExecutionReceipt> => {
      const meta = current();
      const prepared =
        deps.events.getOrdinaryWorkspaceSessionPreparationForConversation(workerId) ??
        deps.events.getOrdinarySessionPreparationForConversation(workerId);
      if (
        !prepared ||
        prepared.delegationAttemptId !== attempt.attemptId ||
        prepared.allocationOperationId !== attempt.allocationReceiptId
      )
        throw Error('Original delegated worker preparation required');
      const settings = prepared.settings;
      const receipt = (): TelosSliceExecutionReceipt | undefined => {
        const send = deps.events.getSendCommand(commandId);
        const admission = deps.events.getOrdinaryCommandAdmission(commandId);
        if (!send && !admission) return undefined;
        if (
          send?.sessionId !== workerId ||
          !admission ||
          !isDeepStrictEqual(admission.binding, settings.binding) ||
          !isDeepStrictEqual(admission.selection, settings.selection) ||
          admission.workspace.cwd !== meta.cwd
        )
          throw Error('Original worker command admission changed');
        return {
          allocation,
          execution: {
            commandId,
            state: send.error
              ? 'failed'
              : deps.accepted(workerId, meta.accountBinding!, commandId)
                ? 'started'
                : admission.state === 'uncertain'
                  ? 'uncertain'
                  : 'admitted',
            ...(send.error ? { code: 'ordinary_command_failed' } : {}),
          },
        };
      };
      const recorded = receipt();
      if (recorded) return recorded;
      // A retained request with no admission is uncertainty, never permission to
      // replay an interrupted physical startup, even after a controller restart.
      const requested = deps.events
        .getSessionEvents(workerId)
        .some(
          (event) =>
            event.type === 'telos_worker_start_requested' && event.payload.commandId === commandId,
        );
      if (requested)
        return {
          allocation,
          execution: { commandId, state: 'uncertain', code: 'worker_start_unconfirmed' },
        };
      const beforeStart = () => {
        const session = current();
        if (
          deps.occupied(workerId) ||
          deps.hasNativeConversation(workerId) ||
          deps.events.getOrdinaryInitialCommandId(workerId)
        )
          throw Error('Worker already has runtime activity; recover its original command');
        assertTelosWorkCommandAdmission(
          { events: deps.events, tasks: deps.tasks, work: () => deps.work },
          workerId,
          session.accountBinding ?? undefined,
        );
      };
      beforeStart();
      const selected = await deps.qualify(settings, workerId, authority.signal);
      beforeStart();
      if (prepared.version === 2) {
        await deps.workspaces.revalidateOrdinaryWorkspace({
          id: prepared.workspaceId,
          conversationId: workerId,
          binding: selected.binding,
          taskRoot: selected.taskRoot,
          signal: authority.signal,
        });
      } else {
        await deps.workspaces.qualifyOrdinarySessionReservation({
          allocationOperationId: prepared.allocationOperationId,
          delegationAttemptId: attempt.attemptId,
          id: prepared.workspaceId,
          ...selected,
          settings: prepared.settings,
          signal: authority.signal,
        });
      }
      beforeStart();
      if (
        !isDeepStrictEqual(selected.binding, meta.accountBinding) ||
        !isDeepStrictEqual(selected.agentProfile, meta.agentProfile)
      )
        throw Error('Original worker account and profile required');
      const assertPrepared =
        prepared.version === 2
          ? deps.events.assertPreparedOrdinaryWorkspaceSession.bind(deps.events)
          : deps.events.assertPreparedOrdinarySession.bind(deps.events);
      assertPrepared(prepared.allocationOperationId, meta, settings.binding, settings.selection);
      deps.events.append(workerId, 'telos_worker_start_requested', {
        version: 1,
        commandId,
        attemptId: attempt.attemptId,
        leadConversationId: authority.sourceConversationId,
      });
      try {
        await deps.dispatch({
          transport: new NullTransport(),
          clientId: `telos-worker:${attempt.attemptId}`,
          sessionId: workerId,
          commandId,
          command: {
            clientMsgId: commandId,
            capabilityRevision: selected.capabilityRevision,
            runtime: {
              account: settings.binding.account,
              harness: settings.binding.harness.implementation,
              targetId: settings.binding.execution.targetId,
              mode: settings.selection.permission.mode,
            },
            selection: settings.selection,
            payload: { text: prompt },
          },
          reservation: {
            id: prepared.workspaceId,
            conversationId: workerId,
            binding: selected.binding,
            taskRoot: selected.taskRoot,
            runtimeBinding: settings.binding,
            commandFingerprint: prepared.preparationFingerprint,
          },
          operatorConnectionId: authority.operatorConnectionId,
          ownerAuthSessionId: authority.authSessionId,
          signal: authority.signal,
          assertCurrent: () => {
            current();
          },
          continuation: false,
          existingOwner: false,
          workspaceKind: prepared.version === 2 ? 'ordinary' : 'repository',
          preparationOperationId: prepared.allocationOperationId,
          profile: selected.agentProfile,
          sandboxWorkdir: selected.sandboxWorkdir,
        });
      } catch (cause) {
        let retained = failures.get(deps.events);
        if (!retained) failures.set(deps.events, (retained = new Map()));
        retained.set(commandId, cause);
        if (retained.size > 32) retained.delete(retained.keys().next().value!);
        try {
          log.error('Telos worker startup unconfirmed', {
            stage: 'ordinary_admission',
            code: 'telos_worker_start_unconfirmed',
            commandId,
            attemptId: attempt.attemptId,
            workerConversationId: workerId,
            leadConversationId: authority.sourceConversationId,
          });
        } catch (diagnosticCause) {
          retainTelosDiagnosticFailure(cause, diagnosticCause, {
            stage: 'ordinary_admission',
            operation: 'start_worker',
            sessionId: workerId,
          });
        }
      }
      current();
      return (
        receipt() ?? {
          allocation,
          execution: { commandId, state: 'uncertain', code: 'worker_start_unconfirmed' },
        }
      );
    };
    const operation = run();
    running.set(commandId, operation);
    try {
      return await operation;
    } finally {
      if (running.get(commandId) === operation) running.delete(commandId);
    }
  };
}
