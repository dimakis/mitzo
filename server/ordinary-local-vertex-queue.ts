import { assertOwnedCodexQueueControl } from './owned-codex-queue-control.js';
import type { EventStore } from './event-store.js';
import type { AuthSession } from './auth.js';
export function readOwnedVertexQueue(events: EventStore, sessionId: string, connected: boolean) {
  const meta = events.getSession(sessionId),
    selection = events.getLatestOrdinaryCommandAdmission(sessionId)?.selection;
  if (!meta?.accountBinding || meta.accountBinding.provider !== 'anthropic-vertex')
    throw Error('Original SDK queue unavailable');
  return {
    paused:
      !connected ||
      (meta.executionPhase === 'TERMINAL' && meta.executionTerminalReason === 'stopped'),
    connected,
    recovering: false,
    queued: events.getPendingOrdinaryLocalVertexCommandIds(sessionId).length,
    interrupted:
      meta?.executionTerminalReason === 'interrupted' || meta?.executionTerminalReason === 'stopped'
        ? 1
        : 0,
    failed: meta?.executionTerminalReason === 'failed' ? 1 : 0,
    retryable: false,
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
