import type { SymposiumProvenance } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

export type SymposiumPerspective = { kind: 'all' } | { kind: 'seat'; seatId: string };

export type SymposiumPerspectiveItem =
  | {
      kind: 'authored';
      eventSeq: number;
      messageId: string;
      seatId: string | null;
      content: string;
      provenance: SymposiumProvenance | null;
    }
  | {
      kind: 'recipient-input';
      eventSeq: number;
      deliveryId: string;
      recipientSeatId: string;
      sourceSeatId: string | null;
      sourceMessageId: string | null;
      content: string;
      attemptId: number;
      recipientStatus: string;
      receipt: 'received' | 'uncertain';
      acceptedAt: number | null;
      providerThreadId: string | null;
      providerTurnId: string | null;
    };

export interface SymposiumQueuedInput {
  deliveryId: string;
  recipientSeatId: string;
  sourceSeatId: string | null;
  sourceMessageId: string | null;
  proposedContent: string;
  deliveryStatus: string;
  createdAt: number;
}

/** Pending input is shown separately from the ordered received/uncertain transcript. */
export function getSymposiumQueuedInputs(
  store: EventStore,
  sessionId: string,
  perspective: SymposiumPerspective,
  limit = 100,
): SymposiumQueuedInput[] {
  return store
    .getQueuedSymposiumRecipients(
      sessionId,
      perspective.kind === 'seat' ? perspective.seatId : undefined,
      limit,
    )
    .map(({ delivery, seatId }) => ({
      deliveryId: delivery.deliveryId,
      recipientSeatId: seatId,
      sourceSeatId: delivery.sourceSeatId,
      sourceMessageId: delivery.sourceMessageId ?? null,
      proposedContent: delivery.deliveredContent ?? delivery.originalContent,
      deliveryStatus: delivery.status,
      createdAt: delivery.createdAt,
    }));
}

/** A bounded event-page projection; only an exact provider acceptance proves received context. */
export function getSymposiumPerspective(
  store: EventStore,
  sessionId: string,
  perspective: SymposiumPerspective,
  options: { afterSeq?: number; limit?: number } = {},
): { items: SymposiumPerspectiveItem[]; nextSeq: number | null } {
  const events = store.getSymposiumPerspectiveEvents(
    sessionId,
    options.afterSeq ?? 0,
    options.limit ?? 200,
  );
  const items: SymposiumPerspectiveItem[] = [];
  for (const event of events) {
    if (event.type === 'symposium_delivery_dispatched') {
      const claimToken = event.payload.claimToken;
      if (typeof claimToken !== 'string') continue;
      const attempt = store.getSymposiumRecipientAttemptByClaimToken(claimToken);
      if (!attempt || attempt.dispatchSeq !== event.seq || attempt.dispatchedContent === null)
        continue;
      if (perspective.kind === 'seat' && attempt.seatId !== perspective.seatId) continue;
      const delivery = store.getSymposiumDelivery(attempt.deliveryId);
      if (!delivery || delivery.sessionId !== sessionId) continue;
      items.push({
        kind: 'recipient-input',
        eventSeq: event.seq,
        deliveryId: delivery.deliveryId,
        recipientSeatId: attempt.seatId,
        sourceSeatId: delivery.sourceSeatId,
        sourceMessageId: delivery.sourceMessageId ?? null,
        content: attempt.dispatchedContent,
        attemptId: attempt.attemptId,
        recipientStatus: attempt.status,
        receipt: attempt.acceptedAt === null ? 'uncertain' : 'received',
        acceptedAt: attempt.acceptedAt,
        providerThreadId: attempt.providerThreadId,
        providerTurnId: attempt.providerTurnId,
      });
      continue;
    }
    const messageId = event.payload.messageId;
    if (typeof messageId !== 'string') continue;
    if (perspective.kind === 'seat' && event.seatId !== perspective.seatId) continue;
    const source = store.getSymposiumSourceMessage(sessionId, messageId);
    if (!source) continue;
    items.push({
      kind: 'authored',
      eventSeq: event.seq,
      messageId,
      seatId: source.seatId,
      content: source.content,
      provenance: source.provenance,
    });
  }
  return { items, nextSeq: events.length === (options.limit ?? 200) ? events.at(-1)!.seq : null };
}
