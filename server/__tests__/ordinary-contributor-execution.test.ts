import { expect, it, vi } from 'vitest';
import {
  assertOrdinaryContributorSendAllowed,
  authorizeOrdinaryContributorStart,
  type OrdinaryContributorExecution,
} from '../ordinary-contributor-execution.js';

const execution: OrdinaryContributorExecution = {
  coordinatorSessionId: 'coordinator',
  deliveryId: 'delivery',
  seatId: 'contributor',
  claimToken: 'claim',
  idempotencyKey: 'recipient',
};
function owner() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const claims = [{ claimToken: 'claim', idempotencyKey: 'recipient' }];
  return {
    events,
    claims,
    getSessionEvents: () => events,
    append: vi.fn((_id: string, type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return events.length;
    }),
    getUnsettledSymposiumSeatExecutions: () => claims,
    getSymposiumDelivery: () => ({
      sessionId: 'coordinator',
      recipients: [{ seatId: 'contributor', status: 'executing', idempotencyKey: 'recipient' }],
    }),
    getSymposiumRecipientAttemptByClaimToken: () => ({
      deliveryId: 'delivery',
      seatId: 'contributor',
      providerThreadId: null as string | null,
    }),
  };
}
it('fences direct messages and cold resumes while the exact contributor claim remains unsettled', () => {
  const store = owner();
  authorizeOrdinaryContributorStart(store, 'child', execution);
  expect(() => assertOrdinaryContributorSendAllowed(store, 'child')).toThrow(/directed messages/);
  expect(() => authorizeOrdinaryContributorStart(store, 'child')).toThrow(/directed messages/);
  store.claims.length = 0;
  expect(() => assertOrdinaryContributorSendAllowed(store, 'child')).not.toThrow();
});
it('uses an old owner marker to fence a newly claimed follow-up before startup', () => {
  const store = owner();
  authorizeOrdinaryContributorStart(store, 'child', execution);
  store.claims[0] = { claimToken: 'next-claim', idempotencyKey: 'next-recipient' };
  expect(() => assertOrdinaryContributorSendAllowed(store, 'child')).toThrow();
});
it('rejects wrong claims, missing claims and another retained child session', () => {
  const store = owner();
  expect(() =>
    authorizeOrdinaryContributorStart(store, 'child', { ...execution, claimToken: 'other' }),
  ).toThrow();
  store.getSymposiumRecipientAttemptByClaimToken = () => ({
    deliveryId: 'delivery',
    seatId: 'contributor',
    providerThreadId: 'original-child',
  });
  expect(() => authorizeOrdinaryContributorStart(store, 'different-child', execution)).toThrow();
  store.claims.length = 0;
  expect(() => authorizeOrdinaryContributorStart(store, 'original-child', execution)).toThrow();
});
