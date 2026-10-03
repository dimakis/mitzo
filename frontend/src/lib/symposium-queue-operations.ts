import type { SymposiumDeliveryRecord, SymposiumProvenance } from '@mitzo/protocol';
export type QueuedMessageRequest = {
  sourceSeatId: string | null;
  sourceMessageId?: string;
  sourceMembershipGeneration?: number;
  recipientSeatIds: string[];
  originalContent: string;
  idempotencyKey: string;
};
export type QueueOperation = {
  sessionId: string;
  request: QueuedMessageRequest;
  phase: 'pending' | 'uncertain' | 'confirmed';
  notice: string;
  deliveryId?: string;
  sourceProvenance?: SymposiumProvenance | null;
};
/** Directed message approvals stay in page memory across keyed chat remounts.
 * Excerpt sharing and execution actions have independent stores and keys. */
function sameProvenance(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, normalize(entry)]),
          )
        : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
export function matchesQueuedMessage(
  operation: QueueOperation,
  value: unknown,
): value is SymposiumDeliveryRecord {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as SymposiumDeliveryRecord;
  const request = operation.request;
  return (
    typeof receipt.deliveryId === 'string' &&
    receipt.deliveryId.trim().length > 0 &&
    [
      'awaiting_intervention',
      'ready',
      'delivering',
      'delivered',
      'dropped',
      'failed',
      'cancelled',
      'recovery_required',
    ].includes(receipt.status) &&
    receipt.sessionId === operation.sessionId &&
    receipt.idempotencyKey === request.idempotencyKey &&
    receipt.sourceSeatId === request.sourceSeatId &&
    (receipt.sourceMessageId ?? null) === (request.sourceMessageId ?? null) &&
    (request.sourceMembershipGeneration === undefined ||
      receipt.sourceProvenance?.membershipGeneration === request.sourceMembershipGeneration) &&
    sameProvenance(receipt.sourceProvenance ?? null, operation.sourceProvenance ?? null) &&
    receipt.originalContent === request.originalContent &&
    Array.isArray(receipt.recipientSeatIds) &&
    JSON.stringify([...receipt.recipientSeatIds].sort()) ===
      JSON.stringify(request.recipientSeatIds)
  );
}
function createQueueOperations(label: 'Message' | 'Excerpt') {
  let operations: Record<string, QueueOperation> = {};
  const listeners = new Set<() => void>();
  return {
    snapshot: () => operations,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(operation: QueueOperation) {
      if (operations[operation.sessionId]) return false;
      operations = { ...operations, [operation.sessionId]: structuredClone(operation) };
      listeners.forEach((listener) => listener());
      return true;
    },
    update(
      sessionId: string,
      key: string,
      change: (operation: QueueOperation) => QueueOperation | undefined,
    ) {
      const previous = operations[sessionId];
      if (!previous || previous.request.idempotencyKey !== key) return;
      const next = change(structuredClone(previous));
      operations = { ...operations };
      if (next) operations[sessionId] = structuredClone(next);
      else delete operations[sessionId];
      listeners.forEach((listener) => listener());
    },
    reconcile(sessionId: string, deliveries: SymposiumDeliveryRecord[]) {
      const operation = operations[sessionId];
      if (!operation || operation.phase === 'confirmed') return;
      const receipt = deliveries.find((delivery) => matchesQueuedMessage(operation, delivery));
      if (receipt)
        this.update(sessionId, operation.request.idempotencyKey, (previous) => ({
          ...previous,
          phase: 'confirmed',
          deliveryId: receipt.deliveryId,
          notice: `${label} already queued`,
        }));
    },
    reset() {
      operations = {};
      listeners.forEach((listener) => listener());
    },
  };
}
export const symposiumQueueOperations = createQueueOperations('Message');
export const symposiumExcerptOperations = createQueueOperations('Excerpt');
