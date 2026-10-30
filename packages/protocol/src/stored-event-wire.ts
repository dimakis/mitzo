import { SymposiumProvenanceSchema } from './symposium.js';
import type { StoredEvent } from './types.js';

/** Project a durable event onto the client wire without trusting payload attribution. */
export function storedEventToClientMessage(
  event: Pick<StoredEvent, 'seq' | 'payload'> &
    Partial<Pick<StoredEvent, 'sessionId' | 'type' | 'seatId' | 'symposiumProvenance'>> & {
      prevSessionSeq?: number;
    },
): Record<string, unknown> {
  const {
    seatId: _payloadSeatId,
    symposiumProvenance: _payloadProvenance,
    seq: _payloadSeq,
    prevSessionSeq: _payloadPrevSessionSeq,
    sessionId: _payloadSessionId,
    type: payloadType,
    startedSeq: payloadStartedSeq,
    ...payload
  } = event.payload;
  const privateType = event.type ?? payloadType;
  if (
    privateType === 'ordinary_reply_source' ||
    privateType === 'ordinary_collaboration_context_staged' ||
    privateType === 'ordinary_collaboration_context_prepared' ||
    privateType === 'ordinary_collaboration_context_accepted'
  ) {
    // The driver mapping stays private in EventStore. Keep its envelope so
    // reconnect acknowledgements and successor predecessors retain this cursor.
    const sessionId = event.sessionId ?? _payloadSessionId;
    return {
      type: privateType,
      ...(event.type === 'ordinary_reply_source' &&
      event.payload.version === 1 &&
      typeof event.payload.commandId === 'string' &&
      typeof event.payload.messageId === 'string'
        ? { messageId: event.payload.messageId, replyToMessageId: event.payload.commandId }
        : {}),
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
      seq: event.seq,
      ...(event.prevSessionSeq !== undefined ? { prevSessionSeq: event.prevSessionSeq } : {}),
    };
  }
  const provenance = event.symposiumProvenance
    ? SymposiumProvenanceSchema.parse(event.symposiumProvenance)
    : undefined;
  if (provenance && event.seatId !== provenance.seatId) {
    throw new Error('Stored Symposium seat does not match its provenance');
  }
  return {
    ...payload,
    ...(event.type !== undefined || payloadType !== undefined
      ? { type: event.type ?? payloadType }
      : {}),
    ...(event.sessionId !== undefined || _payloadSessionId !== undefined
      ? { sessionId: event.sessionId ?? _payloadSessionId }
      : {}),
    seq: event.seq,
    ...(event.type === 'message_start' || event.type === 'user_message'
      ? { startedSeq: event.seq }
      : payloadStartedSeq !== undefined
        ? { startedSeq: payloadStartedSeq }
        : {}),
    ...(event.prevSessionSeq !== undefined ? { prevSessionSeq: event.prevSessionSeq } : {}),
    ...(event.seatId !== undefined ? { seatId: event.seatId } : {}),
    ...(provenance ? { symposiumProvenance: provenance } : {}),
  };
}
