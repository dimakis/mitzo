import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  SymposiumReviewStore,
  type ApplicationPreparation,
} from '../symposium-review-workflows.js';
const h = 'a'.repeat(64),
  d = 'b'.repeat(64);
const selection = (seatId: string, role: string) => ({
  seatId,
  role,
  selectionId: seatId,
  policyRevision: 'config-1',
  profileId: seatId,
  profileRevision: 1,
  accountId: seatId,
  model: 'offline',
});
const create = (store: SymposiumReviewStore) =>
  store.create({
    workflowId: 'w',
    owner: 'user',
    sessionId: 's',
    implementation: {
      version: 1,
      resultId: 'r',
      attemptId: 'initial',
      inputRevision: 'source',
      inputHash: h,
      artifactRevision: 'commit',
      artifactHash: h,
      summary: 'done',
      evidenceRefs: ['commit'],
      completedAt: 1,
    },
    implementer: selection('coder', 'coder'),
    reviewer: selection('reviewer', 'reviewer'),
    acceptanceCriteria: ['works'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 3,
      maxReviewCycles: 1,
      deadlineAt: Date.now() + 60000,
      noProgressLimit: 1,
    },
  });
const intent: ApplicationPreparation = {
  workflowId: 'w',
  attemptId: 'review-1',
  policyReservationId: 'policy-1',
  kind: 'review',
  actorSeatId: 'reviewer',
  artifactRevision: 'commit',
  artifactHash: h,
  transitionId: 'reader-1',
  seal: {
    fenceId: 'fence-1',
    artifactGenerationId: 'generation-1',
    volumeName: 'volume-1',
    sealDigest: d,
    artifactRevision: 'commit',
    artifactHash: h,
  },
  from: { configRevision: 1, membershipGeneration: 1 },
  to: { configRevision: 2, membershipGeneration: 2 },
  expectedSelection: {
    accountId: 'reviewer',
    model: 'offline',
    profileId: 'reviewer',
    profileRevision: '1',
    accountProfileRevision: 'account-1',
  },
};
const claim = {
  workflowId: 'w',
  attemptId: 'review-1',
  policyReservationId: 'policy-1',
  kind: 'review' as const,
  actorSeatId: 'reviewer',
  artifactRevision: 'commit',
  artifactHash: h,
  binding: {
    claimToken: 'claim-1',
    contentHash: createHash('sha256').update('fixture').digest('hex'),
    deliveryId: 'delivery-1',
    membershipGeneration: 2,
    configRevision: 2,
    accountId: 'reviewer',
    model: 'offline',
    profileId: 'reviewer',
    profileRevision: '1',
    accountProfileRevision: 'account-1',
    authorityGrant: { grantId: 'new-authority', revision: 2 },
    contextGrant: { grantId: 'new-context', revision: 2 },
  },
};
it('charges sealed reader preparation exactly once before transition and denies native claim until finalized', () => {
  const store = new SymposiumReviewStore(':memory:');
  create(store);
  expect(store.reserveApplicationPreparation(intent)).toMatchObject({
    kind: 'prepared',
    policyReservationId: 'policy-1',
  });
  expect(store.get('w')).toMatchObject({ hostTurns: 1, reviewCycles: 1 });
  expect(store.applicationAttemptForClaim('claim-1')).toBeNull();
  expect(store.reserveApplicationPreparation(intent)).toMatchObject({ kind: 'already_prepared' });
  expect(
    store.reserveApplicationAttempt({
      ...claim,
      attemptId: 'other',
      policyReservationId: 'other',
      binding: { ...claim.binding, claimToken: 'other' },
    }),
  ).toMatchObject({ code: 'attempt_in_progress' });
  store.close();
});
it('requires exact confirmed seal and future pins to finalize without a second charge', () => {
  const store = new SymposiumReviewStore(':memory:');
  create(store);
  store.reserveApplicationPreparation(intent);
  expect(() =>
    store.completeApplicationPreparation(
      { ...claim, binding: { ...claim.binding, configRevision: 3 } },
      { transitionId: 'reader-1', sealDigest: d },
    ),
  ).toThrow(/transition|pins/);
  expect(
    store.completeApplicationPreparation(claim, { transitionId: 'reader-1', sealDigest: d }),
  ).toMatchObject({ kind: 'admitted' });
  expect(store.get('w')).toMatchObject({ hostTurns: 1, reviewCycles: 1 });
  expect(store.applicationAttemptForClaim('claim-1')).toEqual(claim);
  expect(store.consumeApplicationDispatch(claim)).toMatchObject({ kind: 'dispatch_authorized' });
  store.close();
});
it('keeps uncertain transition preparation charged and blocks continuation until exact disposition', () => {
  const store = new SymposiumReviewStore(':memory:');
  create(store);
  store.reserveApplicationPreparation(intent);
  store.stopApplication('w', 'user', 'user_stop');
  expect(store.get('w')?.hostTurns).toBe(1);
  expect(() =>
    store.continueApplication({
      workflowId: 'w',
      actor: 'user',
      authorizationId: 'fresh',
      reason: 'continue',
      limits: {
        version: 1,
        mode: 'application',
        maxHostTurns: 5,
        maxReviewCycles: 2,
        deadlineAt: Date.now() + 60000,
        noProgressLimit: 1,
      },
    }),
  ).toThrow(/preparation|unresolved/i);
  expect(() => store.settleApplicationPreparation('w', 'review-1', 'wrong', 'not_applied')).toThrow(
    /transition/i,
  );
  store.settleApplicationPreparation('w', 'review-1', 'reader-1', 'not_applied');
  expect(store.get('w')?.hostTurns).toBe(1);
  store.close();
});
