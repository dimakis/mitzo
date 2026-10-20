import type { StoredEvent } from '@mitzo/protocol';
import { publicProviderFailureMessage } from './provider-failure.js';

/** Only an earlier durable user echo can authorize unclassified runtime feedback. */
export function recordAcceptedReplaySession(event: StoredEvent, accepted: Set<string>) {
  const p = event.payload;
  if (
    event.type === 'user_message' &&
    typeof p.messageId === 'string' &&
    p.messageId.trim() &&
    typeof p.text === 'string' &&
    typeof event.sessionId === 'string' &&
    event.sessionId.trim() &&
    (p.sessionId === undefined || p.sessionId === event.sessionId)
  )
    accepted.add(event.sessionId);
}

export function replayError(event: StoredEvent, accepted: Set<string>) {
  const p = event.payload;
  if (p.providerFailure) {
    return { prefix: 'provider-error', message: publicProviderFailureMessage(p.providerFailure) };
  }
  if (
    p.v !== 2 ||
    p.type !== 'error' ||
    p.sessionId !== event.sessionId ||
    !accepted.has(event.sessionId) ||
    p.clientMsgId !== undefined ||
    typeof p.error !== 'string' ||
    !p.error.trim()
  )
    return null;
  return { prefix: 'runtime-error', message: p.error };
}
