import { SymposiumProvenanceSchema } from './symposium.js';
import type { StoredEvent } from './types.js';

/** Project a durable event onto the client wire without trusting payload attribution. */
export function storedEventToClientMessage(
  event: Pick<StoredEvent, 'seq' | 'payload'> &
    Partial<Pick<StoredEvent, 'seatId' | 'symposiumProvenance'>> & {
      prevSessionSeq?: number;
    },
): Record<string, unknown> {
  const {
    seatId: _payloadSeatId,
    symposiumProvenance: _payloadProvenance,
    seq: _payloadSeq,
    prevSessionSeq: _payloadPrevSessionSeq,
    ...payload
  } = event.payload;
  const provenance = event.symposiumProvenance
    ? SymposiumProvenanceSchema.parse(event.symposiumProvenance)
    : undefined;
  if (provenance && event.seatId !== provenance.seatId) {
    throw new Error('Stored Symposium seat does not match its provenance');
  }
  return {
    ...payload,
    seq: event.seq,
    ...(event.prevSessionSeq !== undefined ? { prevSessionSeq: event.prevSessionSeq } : {}),
    ...(event.seatId !== undefined ? { seatId: event.seatId } : {}),
    ...(provenance ? { symposiumProvenance: provenance } : {}),
  };
}
