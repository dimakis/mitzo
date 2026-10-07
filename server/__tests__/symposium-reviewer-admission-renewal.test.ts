import { expect, it, vi } from 'vitest';
import { renewReviewerAdmissionAfterWriter } from '../symposium-reviewer-admission-renewal.js';

it('revalidates the unchanged reviewer at the writer result revision', () => {
  const reviewer = {
    id: 'reviewer',
    role: 'reviewer',
    authorityGrant: { grantId: 'grant', revision: 1, filesystem: 'read', tools: 'read' },
    accountBinding: { accountId: 'account' },
    profileBinding: { profileId: 'profile' },
    contextGrant: { grantId: 'context' },
  };
  const verifySeat = vi.fn();
  const recordProviderAdmission = vi.fn(() => ({
    decision: 'admitted',
    configRevision: 2,
    membershipGeneration: 7,
  }));
  renewReviewerAdmissionAfterWriter({
    context: { owner: 'user', sessionId: 'session' },
    events: {
      getActiveSymposiumConfig: () => ({
        version: 2,
        state: 'active',
        revision: 2,
        seats: [reviewer],
      }),
      getLatestSymposiumMembership: () => ({
        generation: 7,
        state: 'active',
        reconciliation: 'confirmed',
      }),
    },
    grants: { verifySeat },
    runtime: { recordProviderAdmission },
    transitionId: 'writer-transition',
    expectedRevision: 2,
  } as never);
  expect(verifySeat).toHaveBeenCalledWith({
    sessionId: 'session',
    seat: reviewer,
    membershipGeneration: 7,
  });
  expect(recordProviderAdmission).toHaveBeenCalledWith({
    sessionId: 'session',
    seatId: 'reviewer',
    decision: 'admitted',
    idempotencyKey: 'writer-reviewer:writer-transition:reviewer:7',
  });
});

it('does not renew a reviewer after the roster or membership changes', () => {
  const recordProviderAdmission = vi.fn();
  expect(() =>
    renewReviewerAdmissionAfterWriter({
      context: { owner: 'user', sessionId: 'session' },
      events: {
        getActiveSymposiumConfig: () => ({
          version: 2,
          state: 'active',
          revision: 3,
          seats: [{ id: 'reviewer', role: 'reviewer' }],
        }),
        getLatestSymposiumMembership: () => ({
          generation: 7,
          state: 'active',
          reconciliation: 'confirmed',
        }),
      },
      grants: { verifySeat: vi.fn() },
      runtime: { recordProviderAdmission },
      transitionId: 'writer-transition',
      expectedRevision: 2,
    } as never),
  ).toThrow('Writer result revision changed');
  expect(recordProviderAdmission).not.toHaveBeenCalled();
});
