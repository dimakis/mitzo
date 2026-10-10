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
function hasUnsettledContributorExecution(store: ContributorFacts, childSessionId: string) {
  return owners(store, childSessionId).some(
    (record) =>
      store.getUnsettledSymposiumSeatExecutions(record.coordinatorSessionId, record.seatId).length >
      0,
  );
}
export const CONTRIBUTOR_STOP_REQUIRED_MESSAGE =
  'Use Stop on the contributor panel while this conversation has an active or unresolved contributor execution.';
export class ContributorStopOwnershipError extends Error {
  readonly code = 'CONTRIBUTOR_STOP_REQUIRED';
  constructor() {
    super(CONTRIBUTOR_STOP_REQUIRED_MESSAGE);
    this.name = 'ContributorStopOwnershipError';
  }
}
export const CONTRIBUTOR_SEND_REQUIRED_MESSAGE =
  'Use contributor directed messages while its exact execution is active or unresolved';
export class ContributorSendOwnershipError extends Error {
  readonly code = 'CONTRIBUTOR_DIRECTED_MESSAGE_REQUIRED';
  constructor() {
    super(CONTRIBUTOR_SEND_REQUIRED_MESSAGE);
    this.name = 'ContributorSendOwnershipError';
  }
}
/** Public controls must not close a query whose exact terminal is owned by the contributor driver. */
export function assertOrdinaryContributorStopAllowed(
  store: ContributorFacts,
  childSessionId: string,
) {
  if (hasUnsettledContributorExecution(store, childSessionId))
    throw new ContributorStopOwnershipError();
}
/** Permission answers and viewing remain ordinary session operations. New sends are fenced. */
export function assertOrdinaryContributorSendAllowed(
  store: ContributorFacts,
  childSessionId: string,
): void {
  if (hasUnsettledContributorExecution(store, childSessionId))
    throw new ContributorSendOwnershipError();
}
export type OrdinarySessionControl = 'stop' | 'send' | 'interrupt' | 'close';
/** A refused user control leaves the provider turn and its exact owner intact. */
export class SessionControlRejected extends Error {
  constructor(
    readonly sessionId: string,
    readonly control: OrdinarySessionControl,
    error: string,
    readonly code?: string,
  ) {
    super(error);
  }
  toMessage(clientMsgId?: string) {
    return {
      type: 'session_control_rejected' as const,
      sessionId: this.sessionId,
      control: this.control,
      error: this.message,
      ...(this.code ? { code: this.code } : {}),
      ...(clientMsgId ? { clientMsgId } : {}),
    };
  }
}
export function assertOrdinaryContributorControlAllowed(
  store: ContributorFacts,
  childSessionId: string,
  control: OrdinarySessionControl,
): void {
  try {
    if (control === 'stop' || control === 'close')
      assertOrdinaryContributorStopAllowed(store, childSessionId);
    else assertOrdinaryContributorSendAllowed(store, childSessionId);
  } catch (error) {
    throw new SessionControlRejected(
      childSessionId,
      control,
      error instanceof Error
        ? error.message
        : 'Contributor execution ownership could not be verified',
      error instanceof ContributorStopOwnershipError ||
        error instanceof ContributorSendOwnershipError
        ? error.code
        : undefined,
    );
  }
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
