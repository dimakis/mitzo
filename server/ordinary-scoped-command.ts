import { isDeepStrictEqual } from 'node:util';
import type { SessionTransport } from '@mitzo/harness';
import type { AgentLibraryVersion, MitzoMode } from '@mitzo/protocol';
import type { HostRepositoryReservationInput } from './repository-workspaces.js';
import {
  startOwnedLocalCodexCommand,
  sendOwnedLocalCodexCommand,
  startOwnedLocalResponsesCommand,
  sendOwnedLocalResponsesCommand,
} from './chat.js';
import {
  startOwnedLocalVertexCommand,
  sendOwnedLocalVertexCommand,
} from './ordinary-local-vertex-entry.js';
import {
  startOwnedOpenShellCodexCommand,
  sendOwnedOpenShellCodexCommand,
} from './ordinary-openshell-codex-entry.js';
import { sessionHarnessForProvider } from './session-harness-routing.js';

type LocalOptions = Parameters<typeof startOwnedLocalCodexCommand>[2];
export interface OwnedOrdinaryDispatchInput {
  transport: SessionTransport;
  clientId: string;
  sessionId: string;
  commandId: string;
  command: unknown;
  reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  operatorConnectionId: string;
  ownerConnectionId?: string;
  ownerAuthSessionId?: string;
  signal: AbortSignal;
  continuation: boolean;
  existingOwner: boolean;
  workspaceKind: 'ordinary' | 'repository';
  preparationOperationId?: string;
  profile?: AgentLibraryVersion;
  sandboxWorkdir?: string;
  onSessionPrepared?: LocalOptions['onSessionPrepared'];
  onQueryEvent?: LocalOptions['onQueryEvent'];
  onTerminalOutcome?: LocalOptions['onTerminalOutcome'];
  onEnded?: LocalOptions['onEnded'];
  adviserScope?: LocalOptions['adviserScope'];
}

/** The ordinary route and scoped consumers share this final dispatch assembly.
 * Account, workspace, command receipt, FIFO and provider effects stay with their
 * existing admitted owners. This adapter never allocates, retries or falls back.
 */
export async function dispatchOwnedOrdinaryCommand(input: OwnedOrdinaryDispatchInput) {
  input.signal.throwIfAborted();
  const { reservation, sessionId, commandId, command, operatorConnectionId, signal } = input;
  const runtime = (
    command as {
      runtime?: { account?: unknown; harness?: string; targetId?: string };
      selection?: { model?: string; thinking?: string | null; permission?: { mode?: MitzoMode } };
    }
  )?.runtime;
  const selection = (
    command as {
      selection?: { model?: string; thinking?: string | null; permission?: { mode?: MitzoMode } };
    }
  )?.selection;
  const binding = reservation.runtimeBinding;
  if (
    !binding ||
    binding.version !== 2 ||
    reservation.conversationId !== sessionId ||
    !isDeepStrictEqual(runtime?.account, binding.account) ||
    runtime?.harness !== binding.harness.implementation ||
    runtime.targetId !== binding.execution.targetId ||
    (!input.continuation && selection?.model !== reservation.binding.model) ||
    (!input.continuation && runtime.harness !== sessionHarnessForProvider(binding.account.provider))
  )
    throw Error('Exact ordinary dispatch selection required');
  if (
    (input.adviserScope ||
      input.onSessionPrepared ||
      input.onQueryEvent ||
      input.onTerminalOutcome ||
      input.onEnded) &&
    (binding.harness.implementation !== 'codex' || binding.execution.location !== 'local')
  )
    throw Error('Scoped callbacks are unavailable on this execution target');
  const continuation = input.continuation;
  const existing = input.existingOwner;
  const common = { sessionId, command, operatorConnectionId, signal };
  const startup = {
    command,
    reservation,
    operatorConnectionId,
    ownerConnectionId: input.ownerConnectionId,
    ownerAuthSessionId: input.ownerAuthSessionId,
    signal,
    resume: continuation,
  };
  switch (binding.harness.implementation) {
    case 'claude-sdk': {
      if (binding.execution.location !== 'local')
        throw Error('Selected ordinary execution target unavailable');
      const ownerAuthSessionId = input.ownerAuthSessionId;
      if (!ownerAuthSessionId) throw Error('Exact ordinary operator identity required');
      return continuation && existing
        ? sendOwnedLocalVertexCommand(common)
        : startOwnedLocalVertexCommand(input.transport, input.clientId, {
            ...startup,
            ownerAuthSessionId,
          });
    }
    case 'gemini':
    case 'responses': {
      if (binding.execution.location !== 'local')
        throw Error('Selected ordinary execution target unavailable');
      const ownerAuthSessionId = input.ownerAuthSessionId;
      if (!ownerAuthSessionId) throw Error('Exact ordinary operator identity required');
      return continuation && existing
        ? sendOwnedLocalResponsesCommand(common)
        : startOwnedLocalResponsesCommand(input.transport, input.clientId, {
            ...startup,
            ownerAuthSessionId,
          });
    }
    case 'codex':
      if (binding.execution.location === 'openshell') {
        if (
          input.adviserScope ||
          input.onSessionPrepared ||
          input.onQueryEvent ||
          input.onTerminalOutcome
        )
          throw Error('Scoped callbacks are unavailable on this execution target');
        if (!input.sandboxWorkdir || !input.profile || !input.ownerConnectionId)
          throw Error('Original OpenShell workspace and profile required');
        return continuation && existing
          ? sendOwnedOpenShellCodexCommand(common)
          : startOwnedOpenShellCodexCommand(input.transport, input.clientId, {
              command,
              meta: {
                sessionId,
                ...(input.workspaceKind === 'ordinary'
                  ? { ordinaryWorkspaceId: reservation.id }
                  : { repositoryWorkspaceId: reservation.id }),
                accountBinding: reservation.binding,
                agentProfile: input.profile,
                cwd: input.sandboxWorkdir,
                selectedModel: selection!.model!,
                reasoningEffort: selection!.thinking,
                mode: selection!.permission!.mode!,
              },
              ...(!continuation && input.preparationOperationId
                ? { preparationOperationId: input.preparationOperationId }
                : {}),
              taskRoot: reservation.taskRoot,
              operatorConnectionId,
              ownerConnectionId: input.ownerConnectionId,
              signal,
              resume: continuation,
            });
      }
      return continuation && existing
        ? sendOwnedLocalCodexCommand(common)
        : startOwnedLocalCodexCommand(input.transport, input.clientId, {
            workspaceKind: input.workspaceKind,
            ...(!continuation && input.preparationOperationId
              ? { preparationOperationId: input.preparationOperationId }
              : {}),
            command,
            reservation,
            commandId,
            operatorConnectionId,
            ownerConnectionId: input.ownerConnectionId,
            signal,
            resume: continuation,
            ...(input.onSessionPrepared ? { onSessionPrepared: input.onSessionPrepared } : {}),
            ...(input.onQueryEvent ? { onQueryEvent: input.onQueryEvent } : {}),
            ...(input.onTerminalOutcome ? { onTerminalOutcome: input.onTerminalOutcome } : {}),
            ...(input.onEnded ? { onEnded: input.onEnded } : {}),
            ...(input.adviserScope ? { adviserScope: input.adviserScope } : {}),
          });
  }
}
