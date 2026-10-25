import { isDeepStrictEqual } from 'node:util';
import type { StoredEvent } from './event-store.js';

/** Project the known duplicate emitted by the old SDK startup path. Only the
 * original owned command receipt can identify it; retained rows stay untouched. */
export function restoreOwnedVertexInitialPrompt(
  events: StoredEvent[],
  initialPrompt: string | undefined,
  receipt?: { sessionId: string; commandId: string; text: string },
): { events: StoredEvent[]; initialPrompt: string | undefined } {
  if (!receipt) return { events, initialPrompt };
  const ordinary = (event: StoredEvent) =>
    event.sessionId === receipt.sessionId &&
    event.seatId === undefined &&
    event.symposiumProvenance === undefined &&
    !('seatId' in event.payload) &&
    !('symposiumProvenance' in event.payload) &&
    (event.payload.sessionId === undefined || event.payload.sessionId === receipt.sessionId);
  const accepted = events.find(
    (event) =>
      ordinary(event) &&
      event.type === 'user_message' &&
      event.payload.messageId === receipt.commandId &&
      event.payload.text === receipt.text,
  );
  if (!accepted) return { events, initialPrompt };
  const legacyEnvelope =
    initialPrompt !== receipt.text &&
    initialPrompt?.startsWith('Mitzo repository workspace ') &&
    initialPrompt.endsWith(`\n\n${receipt.text}`);
  const duplicate =
    legacyEnvelope || initialPrompt === receipt.text
      ? events.find(
          (event) =>
            ordinary(event) &&
            event.seq > accepted.seq &&
            event.type === 'user_message' &&
            event.payload.messageId === receipt.commandId &&
            event.payload.text === initialPrompt &&
            ['images', 'sourceSnapshots', 'contextBlocks'].every((key) =>
              isDeepStrictEqual(event.payload[key], accepted.payload[key]),
            ),
        )
      : undefined;
  return {
    events: duplicate ? events.filter((event) => event !== duplicate) : events,
    initialPrompt: receipt.text,
  };
}
