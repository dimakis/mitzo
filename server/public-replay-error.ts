import type { StoredEvent } from '@mitzo/protocol';
import { publicProviderFailureMessage } from './provider-failure.js';

/** Session and exact command echoes are scoped to one replay/provenance partition. */
export type AcceptedReplaySessions = Map<string, Set<string>>;

/** Only an earlier durable user echo can authorize unclassified runtime feedback. */
export function recordAcceptedReplaySession(event: StoredEvent, accepted: AcceptedReplaySessions) {
  const p = event.payload;
  if (
    event.type === 'user_message' &&
    typeof p.messageId === 'string' &&
    p.messageId.trim() &&
    typeof p.text === 'string' &&
    typeof event.sessionId === 'string' &&
    event.sessionId.trim() &&
    (p.sessionId === undefined || p.sessionId === event.sessionId)
  ) {
    let commands = accepted.get(event.sessionId);
    if (!commands) {
      commands = new Set();
      accepted.set(event.sessionId, commands);
    }
    commands.add(p.messageId);
  }
}

export function replayError(
  event: StoredEvent,
  accepted: AcceptedReplaySessions,
): {
  prefix: 'provider-error' | 'runtime-error';
  message: string;
  clientMsgId?: string;
} | null {
  const p = event.payload;
  if (p.providerFailure) {
    return { prefix: 'provider-error', message: publicProviderFailureMessage(p.providerFailure) };
  }
  if (
    p.v !== 2 ||
    p.type !== 'error' ||
    p.sessionId !== event.sessionId ||
    !accepted.has(event.sessionId) ||
    typeof p.error !== 'string' ||
    !p.error.trim()
  )
    return null;
  if (p.clientMsgId !== undefined || p.retainedCommandFailure !== undefined) {
    // Only the host's sanitized retained-command error writer sets this marker.
    // A session echo alone cannot disclose arbitrary startup diagnostics or a
    // different command's error, including an echo arriving later in the stream.
    if (
      p.retainedCommandFailure !== true ||
      typeof p.clientMsgId !== 'string' ||
      !accepted.get(event.sessionId)?.has(p.clientMsgId) ||
      !p.error.startsWith('Message saved. ')
    )
      return null;
    return { prefix: 'runtime-error', message: p.error, clientMsgId: p.clientMsgId };
  }
  return { prefix: 'runtime-error', message: p.error };
}
