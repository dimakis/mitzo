import { z } from 'zod';

const Execution = z.strictObject({
  coordinatorSessionId: z.string().min(1),
  deliveryId: z.string().min(1),
  seatId: z.string().min(1),
  claimToken: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
const Owner = Execution.extend({ childSessionId: z.string().min(1) });
export type OrdinaryContributorExecution = z.infer<typeof Execution>;
interface ContributorFacts {
  getSessionEvents(sessionId: string): Array<{ type: string; payload: Record<string, unknown> }>;
  getUnsettledSymposiumSeatExecutions(
    sessionId: string,
    seatId: string,
  ): Array<{ claimToken: string | null; idempotencyKey: string }>;
}
interface ContributorOwner extends ContributorFacts {
  append(sessionId: string, type: string, payload: Record<string, unknown>): number;
  getSymposiumDelivery(deliveryId: string):
    | {
        sessionId: string;
        recipients: Array<{ seatId: string; status: string; idempotencyKey: string }>;
      }
    | undefined;
  getSymposiumRecipientAttemptByClaimToken(
    claimToken: string,
  ): { deliveryId: string; seatId: string; providerThreadId: string | null } | undefined;
}
function owners(store: ContributorFacts, childSessionId: string) {
  const records = store
    .getSessionEvents(childSessionId)
    .filter((event) => event.type === 'contributor_execution')
    .map((event) => Owner.parse(event.payload));
  if (records.some((record) => record.childSessionId !== childSessionId))
    throw new Error('Contributor child ownership changed');
  return records;
}
/** Permission answers and viewing remain ordinary session operations. New sends are fenced. */
export function assertOrdinaryContributorSendAllowed(
  store: ContributorFacts,
  childSessionId: string,
): void {
  if (
    owners(store, childSessionId).some(
      (record) =>
        store.getUnsettledSymposiumSeatExecutions(record.coordinatorSessionId, record.seatId)
          .length > 0,
    )
  )
    throw new Error(
      'Use contributor directed messages while its exact execution is active or unresolved',
    );
}
/** Trusted start only; authorizes one existing claim without creating execution authority. */
export function authorizeOrdinaryContributorStart(
  store: ContributorOwner,
  childSessionId: string,
  selected?: OrdinaryContributorExecution,
): void {
  if (!selected) return assertOrdinaryContributorSendAllowed(store, childSessionId);
  const execution = Execution.parse(selected);
  const attempt = store.getSymposiumRecipientAttemptByClaimToken(execution.claimToken);
  const delivery = store.getSymposiumDelivery(execution.deliveryId);
  const recipient = delivery?.recipients.find((row) => row.seatId === execution.seatId);
  if (
    !attempt ||
    attempt.deliveryId !== execution.deliveryId ||
    attempt.seatId !== execution.seatId ||
    delivery?.sessionId !== execution.coordinatorSessionId ||
    recipient?.status !== 'executing' ||
    recipient.idempotencyKey !== execution.idempotencyKey ||
    (attempt.providerThreadId && attempt.providerThreadId !== childSessionId) ||
    !store
      .getUnsettledSymposiumSeatExecutions(execution.coordinatorSessionId, execution.seatId)
      .some(
        (claim) =>
          claim.claimToken === execution.claimToken &&
          claim.idempotencyKey === execution.idempotencyKey,
      )
  )
    throw new Error('Exact contributor execution ownership is required');
  const retained = owners(store, childSessionId);
  if (
    retained.some(
      (record) =>
        record.coordinatorSessionId !== execution.coordinatorSessionId ||
        record.seatId !== execution.seatId,
    )
  )
    throw new Error('Contributor child belongs to another seat');
  if (!retained.some((record) => record.claimToken === execution.claimToken))
    store.append(childSessionId, 'contributor_execution', { ...execution, childSessionId });
}
