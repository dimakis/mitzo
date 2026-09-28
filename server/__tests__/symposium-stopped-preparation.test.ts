import { expect, it, vi } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import { reconcileStoppedApplicationPreparation } from '../symposium-stopped-preparation.js';

const sha = 'a'.repeat(64);
const selection = (id: string, role: string) => ({
  seatId: id,
  role,
  selectionId: id,
  policyRevision: 'p',
  profileId: id,
  profileRevision: 1,
  accountId: id,
  model: 'offline',
});
const prep = {
  workflowId: 'flow',
  attemptId: 'attempt',
  policyReservationId: 'policy',
  kind: 'review' as const,
  actorSeatId: 'reviewer',
  artifactRevision: 'commit',
  artifactHash: sha,
  transitionId: 'reader-transition',
  seal: {
    fenceId: 'fence',
    artifactGenerationId: 'generation',
    volumeName: 'volume',
    sealDigest: sha,
    artifactRevision: 'commit',
    artifactHash: sha,
  },
  from: { configRevision: 1, membershipGeneration: 1 },
  to: { configRevision: 2, membershipGeneration: 2 },
  expectedSelection: {
    accountId: 'reviewer',
    model: 'offline',
    profileId: 'reviewer',
    profileRevision: '1',
    accountProfileRevision: '1',
  },
};

function fixture() {
  const reviews = new SymposiumReviewStore(':memory:');
  reviews.create({
    workflowId: 'flow',
    owner: 'owner',
    sessionId: 'session',
    implementation: {
      version: 1,
      resultId: 'result',
      attemptId: 'initial',
      inputRevision: 'source',
      inputHash: sha,
      artifactRevision: 'commit',
      artifactHash: sha,
      summary: 'done',
      evidenceRefs: ['evidence'],
      completedAt: 1,
    },
    implementer: selection('coder', 'coder'),
    reviewer: selection('reviewer', 'reviewer'),
    acceptanceCriteria: ['works'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 3,
      maxReviewCycles: 2,
      deadlineAt: Date.now() + 60000,
      noProgressLimit: 1,
    },
  });
  reviews.reserveApplicationPreparation(prep);
  reviews.stopApplication('flow', 'owner', 'user_stop');
  const events = {
    getActiveSymposiumConfig: vi.fn(() => ({
      version: 2,
      state: 'active',
      revision: 1,
      seats: [{ id: 'reviewer', role: 'reviewer' }],
    })),
    getLatestSymposiumMembership: vi.fn(() => ({
      state: 'active',
      reconciliation: 'confirmed',
      generation: 1,
    })),
    getSymposiumSealedReaderAdmission: vi.fn(() => null),
    getSymposiumArtifactAdmission: vi.fn(() => null),
    getSymposiumDeliveryByIdempotencyKey: vi.fn(() => undefined),
    getSymposiumRecipientAttempts: vi.fn(() => []),
    getSymposiumArtifactReference: vi.fn(() => null),
  };
  const context = { owner: 'owner', sessionId: 'session' };
  return { reviews, events, context };
}

it('proves a stopped reader preparation was not applied only while exact old state remains', async () => {
  const f = fixture();
  expect(
    await reconcileStoppedApplicationPreparation(
      {
        reviews: f.reviews,
        events: f.events as never,
        cancelDelivery: vi.fn(),
        successorState: vi.fn(),
      },
      f.context,
      prep,
    ),
  ).toBe('not_applied');
  f.events.getActiveSymposiumConfig.mockReturnValue({
    version: 2,
    state: 'active',
    revision: 2,
    seats: [{ id: 'reviewer', role: 'reviewer' }],
  });
  expect(
    await reconcileStoppedApplicationPreparation(
      {
        reviews: f.reviews,
        events: f.events as never,
        cancelDelivery: vi.fn(),
        successorState: vi.fn(),
      },
      f.context,
      prep,
    ),
  ).toBeNull();
  f.reviews.close();
});

it('retains the stop fence if a delivery has native attempt evidence', async () => {
  const f = fixture();
  f.events.getSymposiumDeliveryByIdempotencyKey.mockReturnValue({
    deliveryId: 'delivery',
    status: 'awaiting_intervention',
  } as never);
  f.events.getSymposiumRecipientAttempts.mockReturnValue([{}] as never);
  const cancelDelivery = vi.fn();
  expect(
    await reconcileStoppedApplicationPreparation(
      {
        reviews: f.reviews,
        events: f.events as never,
        cancelDelivery,
        successorState: vi.fn(),
      },
      f.context,
      prep,
    ),
  ).toBeNull();
  expect(cancelDelivery).not.toHaveBeenCalled();
  f.reviews.close();
});

it('cancels an exact applied reader delivery and proves no native dispatch', async () => {
  const f = fixture();
  const binding = {
    sessionId: 'session',
    workflowId: 'flow',
    policyReservationId: 'policy',
    seatId: 'reviewer',
    operationId: 'reader-transition',
    readerAdmissionId: 'reader-transition',
    reviewAttemptId: 'attempt',
    sealFenceId: 'fence',
    sealDigest: sha,
    artifactGenerationId: 'generation',
    expectedConfigRevision: 1,
    resultingConfigRevision: 2,
    readerMembershipGeneration: 2,
  };
  const reference = { bindingDigest: artifactAdmissionDigest(binding) };
  f.events.getSymposiumSealedReaderAdmission.mockReturnValue({
    binding,
    reference,
    receipt: {
      readerAdmissionId: 'reader-transition',
      bindingDigest: artifactAdmissionDigest(binding),
      sessionId: 'session',
      artifactGenerationId: 'generation',
      seatId: 'reviewer',
      confirmedAt: 2,
    },
  } as never);
  f.events.getSymposiumArtifactReference.mockReturnValue(reference as never);
  f.events.getActiveSymposiumConfig.mockReturnValue({
    version: 2,
    state: 'active',
    revision: 2,
    seats: [{ id: 'reviewer', role: 'reviewer' }],
  });
  f.events.getLatestSymposiumMembership.mockReturnValue({
    state: 'active',
    reconciliation: 'confirmed',
    generation: 2,
  });
  f.events.getSymposiumDeliveryByIdempotencyKey.mockReturnValue({
    deliveryId: 'delivery',
    status: 'awaiting_intervention',
  } as never);
  const cancelDelivery = vi.fn(async () => ({ status: 'cancelled' }));
  expect(
    await reconcileStoppedApplicationPreparation(
      {
        reviews: f.reviews,
        events: f.events as never,
        cancelDelivery,
        successorState: vi.fn(),
      },
      f.context,
      prep,
    ),
  ).toBe('applied_no_dispatch');
  expect(cancelDelivery).toHaveBeenCalledWith('delivery', 'review-stop-preparation:policy');
  f.events.getSymposiumSealedReaderAdmission.mockReturnValue({
    binding,
    reference,
    receipt: {
      readerAdmissionId: 'reader-transition',
      bindingDigest: 'b'.repeat(64),
      sessionId: 'session',
      artifactGenerationId: 'generation',
      seatId: 'reviewer',
      confirmedAt: 2,
    },
  } as never);
  expect(
    await reconcileStoppedApplicationPreparation(
      {
        reviews: f.reviews,
        events: f.events as never,
        cancelDelivery,
        successorState: vi.fn(),
      },
      f.context,
      prep,
    ),
  ).toBeNull();
  f.reviews.close();
});
