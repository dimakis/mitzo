import { assertOwnedCodexQueueControl } from './owned-codex-queue-control.js';
import type { EventStore } from './event-store.js';
import type { AuthSession } from './auth.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  observedOrdinarySdkOutcome,
  readOrdinarySdkTurnDiagnostic,
} from './ordinary-sdk-turn-evidence.js';
import type { OrdinarySessionPromptPort } from './session-prompt-dispatch.js';

/** One explicit retry intent per immutable source. The existing send ledger
 * owns admission/uncertainty; no original command receipt is reset. */
export function ordinarySdkRetryCommandId(sourceCommandId: string) {
  return `sdk-retry:${createHash('sha256').update(sourceCommandId).digest('hex')}`;
}

/** Positive original-owner evidence only. Historical reads recover a receipt;
 * they never authorize another dispatch after newer work has started. */
export function readOwnedVertexRetrySource(
  events: EventStore,
  sessionId: string,
  sourceCommandId = events.getCurrentExecutionCommandId(sessionId),
  historical = false,
) {
  if (!sourceCommandId || sourceCommandId.startsWith('collaboration:')) return;
  const meta = events.getSession(sessionId);
  const admission = events.getOrdinaryLocalVertexCommandAdmission(sourceCommandId);
  const command = events.getSendCommand(sourceCommandId);
  const execution = events.getExecutionAdmission(sessionId, sourceCommandId);
  if (
    !meta ||
    !admission ||
    admission.state !== 'consumed' ||
    command?.sessionId !== sessionId ||
    !execution ||
    events.agentCommunication.forCommand(sourceCommandId)
  )
    return;
  const terminal = events.getExecutionTerminalReason(execution.token);
  const settledFailure =
    !command.error &&
    terminal === 'failed' &&
    observedOrdinarySdkOutcome(events, sessionId, sourceCommandId) === 'failed';
  const unsent =
    terminal === 'abandoned' &&
    command.error === 'Cancelled before SDK dispatch' &&
    events.getOrdinarySdkTurnEvents(sessionId, sourceCommandId).length === 0;
  if (!settledFailure && !unsent) return;
  const childId = ordinarySdkRetryCommandId(sourceCommandId);
  if (!historical) {
    const current = events.getCurrentExecutionCommandId(sessionId);
    if (
      (current !== sourceCommandId && current !== childId) ||
      (current === sourceCommandId && meta.executionPhase !== 'TERMINAL') ||
      events.hasUncertainOrdinaryCommand(sessionId, childId)
    )
      return;
  }
  return { sourceCommandId, childId, admission, command, requiresConfirmation: settledFailure };
}

export async function retryOwnedVertexFailedTurn(
  events: EventStore,
  port: Pick<OrdinarySessionPromptPort, 'deliverOrdinary'>,
  sessionId: string,
  sourceCommandId: string,
  confirmAmbiguous: boolean,
  authorization?: AuthSession,
): Promise<'queued' | 'not_found' | 'not_retryable' | 'confirmation_required' | 'unavailable'> {
  assertOwnedVertexQueueControl(events, sessionId, authorization);
  if (!authorization) return 'unavailable';
  const source = readOwnedVertexRetrySource(events, sessionId, sourceCommandId, true);
  if (!source) return 'not_retryable';
  const previous = events.getSendCommand(source.childId);
  if (previous) {
    const admission = events.getOrdinaryLocalVertexCommandAdmission(source.childId);
    if (
      previous.sessionId !== sessionId ||
      previous.error ||
      !admission ||
      !isDeepStrictEqual(admission.selection, source.admission.selection) ||
      !isDeepStrictEqual(admission.binding, source.admission.binding) ||
      !isDeepStrictEqual(admission.workspace, source.admission.workspace) ||
      !isDeepStrictEqual(previous.payload, source.command.payload) ||
      !isDeepStrictEqual(
        events.getOrdinarySkillContext(sessionId, source.childId),
        events.getOrdinarySkillContext(sessionId, sourceCommandId),
      ) ||
      (events.contextTransitions.readCommand(source.childId)?.epoch ?? 0) !==
        (events.contextTransitions.readCommand(sourceCommandId)?.epoch ?? 0)
    )
      return 'not_retryable';
    return admission.state === 'consumed' ? 'queued' : 'unavailable';
  }
  if (!readOwnedVertexRetrySource(events, sessionId, sourceCommandId)) return 'not_retryable';
  if (source.requiresConfirmation && !confirmAmbiguous) return 'confirmation_required';
  const current = () => {
    assertOwnedVertexQueueControl(events, sessionId, authorization);
    events.assertOrdinaryContextCommand(sessionId, sourceCommandId);
    if (!readOwnedVertexRetrySource(events, sessionId, sourceCommandId))
      throw Error('Original SDK retry requires reconciliation');
  };
  current();
  const dispatch = (assertSourceCurrent: () => void) => ({
    pending: port.deliverOrdinary(
      {
        sessionId,
        commandId: source.childId,
        auth: authorization,
        text: String(source.command.payload.text),
        settings: {
          binding: source.admission.binding,
          selection: source.admission.selection,
          repositoryWorkspaceId: source.admission.workspace.workspaceId,
        },
        sdkRetrySourceCommandId: sourceCommandId,
      },
      new AbortController().signal,
      () => {
        current();
        assertSourceCurrent();
      },
    ),
  });
  const { pending } = source.requiresConfirmation
    ? events.withOrdinaryDerivedCommandContext(sessionId, sourceCommandId, dispatch)
    : events.withOrdinaryUnsentSdkRetryContext(sessionId, sourceCommandId, dispatch);
  await pending;
  return 'queued';
}

export function readOwnedVertexQueue(events: EventStore, sessionId: string, connected: boolean) {
  const meta = events.getSession(sessionId),
    selection = events.getLatestOrdinaryCommandAdmission(sessionId)?.selection;
  if (
    !meta?.accountBinding ||
    !['anthropic-vertex', 'anthropic-claude', 'anthropic-api'].includes(
      meta.accountBinding.provider,
    )
  )
    throw Error('Original SDK queue unavailable');
  const retry = readOwnedVertexRetrySource(events, sessionId);
  return {
    paused:
      !connected ||
      !!retry ||
      (meta.executionPhase === 'TERMINAL' && meta.executionTerminalReason === 'stopped'),
    connected,
    recovering: false,
    queued: events.getPendingOrdinaryLocalVertexCommandIds(sessionId).length,
    interrupted:
      meta?.executionTerminalReason === 'interrupted' || meta?.executionTerminalReason === 'stopped'
        ? 1
        : 0,
    failed: meta?.executionTerminalReason === 'failed' || retry ? 1 : 0,
    retryable: !!retry,
    ...(retry
      ? {
          retrySourceCommandId: retry.sourceCommandId,
          requiresRetryConfirmation: retry.requiresConfirmation,
        }
      : {}),
    model: selection?.model ?? meta.accountBinding.model,
    reasoningEffort: selection?.thinking,
  };
}
export function readOwnedVertexQueueOverview(events: EventStore, sessionId: string) {
  return {
    queued: events
      .getPendingOrdinaryLocalVertexCommandIds(sessionId)
      .map((id) => ({ id, preview: events.ordinaryCommandPreview(id, sessionId) ?? '' })),
    cancelledIds: events.getCancelledOrdinaryLocalVertexCommandIds(sessionId),
    hasMore: false,
  };
}

/** Supported read-only inspection of the original SDK command after a cold
 * reconnect. This cannot settle an execution or reconstruct dispatch consent. */
export function readOwnedVertexRecovery(
  events: EventStore,
  sessionId: string,
  authorization?: AuthSession,
) {
  assertOwnedVertexQueueControl(events, sessionId, authorization);
  const custody = events.getOrdinaryLocalVertexCustody(sessionId);
  if (!custody) throw Error('Original SDK custody unavailable');
  const commandId = events.getCurrentExecutionCommandId(sessionId) ?? custody.initialCommandId;
  const admission = events.getOrdinaryLocalVertexCommandAdmission(commandId);
  const command = events.getSendCommand(commandId);
  if (!admission || command?.sessionId !== sessionId)
    throw Error('Original SDK command receipt unavailable');
  const execution = events.getExecutionAdmission(sessionId, commandId);
  const evidence = readOrdinarySdkTurnDiagnostic(events, sessionId, commandId);
  if (evidence.inputAcknowledged && evidence.providerThreadId !== custody.sdkSessionId)
    throw Error('Original SDK provider thread identity changed');
  return {
    version: 1,
    sessionId,
    sdkSessionId: custody.sdkSessionId,
    commandId,
    admissionState: admission.state,
    executionTerminalReason: execution && events.getExecutionTerminalReason(execution.token),
    ...evidence,
    status: evidence.inputCancellation
      ? 'cancelled_before_dispatch'
      : evidence.sdkOutcome && evidence.sdkOutcome !== 'uncertain'
        ? 'settled'
        : 'unconfirmed',
    mayReplay: false,
    nextAction: 'inspect_original_owner',
  };
}
export function cancelOwnedVertexQueuedCommand(
  events: EventStore,
  sessionId: string,
  commandId: string,
  authorization?: AuthSession,
) {
  assertOwnedVertexQueueControl(events, sessionId, authorization);
  return events.cancelOrdinaryLocalVertexQueuedCommand(sessionId, commandId);
}
export function assertOwnedVertexQueueControl(
  events: EventStore,
  sessionId: string,
  authorization?: AuthSession,
) {
  const binding = events.getSessionRuntimeBinding(sessionId);
  if (binding?.harness.implementation !== 'claude-sdk' || binding.execution.location !== 'local')
    throw Error('Original SDK queue unavailable');
  assertOwnedCodexQueueControl(
    {
      runtimeBinding: (id) => events.getSessionRuntimeBinding(id),
      accountBinding: (id) => events.getSession(id)?.accountBinding,
      custody: (id) => events.getOrdinaryLocalVertexCustody(id),
    },
    sessionId,
    authorization,
  );
}
