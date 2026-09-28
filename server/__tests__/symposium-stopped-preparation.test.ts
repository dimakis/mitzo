import { expect, it, vi } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import { reconcileStoppedApplicationPreparation } from '../symposium-stopped-preparation.js';
import { createHash } from 'node:crypto';

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

function fixture(stopped = true) {
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
  if (stopped) reviews.stopApplication('flow', 'owner', 'user_stop');
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
  expect(cancelDelivery).toHaveBeenCalledWith('delivery', 'review-stop-preparation:policy', {
    workflowId: 'flow',
    attemptId: 'attempt',
    policyReservationId: 'policy',
  });
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

it('pauses an exact bound writer before proving same-attempt resumability', async () => {
  const writer = {
    ...prep,
    kind: 'fix' as const,
    actorSeatId: 'coder',
    transitionId: 'fix-child',
    expectedSelection: { ...prep.expectedSelection, accountId: 'coder', profileId: 'coder' },
  };
  const content = 'staged fixed work';
  const binding = {
    sessionId: 'session',
    workflowId: 'flow',
    policyReservationId: 'policy',
    seatId: 'coder',
    operationId: 'fix-child',
    transitionId: 'fix-child',
    kind: 'fix',
    fixAttemptId: 'attempt',
    parentGenerationId: 'generation',
    parentSealDigest: sha,
    expectedConfigRevision: 1,
    resultingConfigRevision: 2,
    successorMembershipGeneration: 2,
  };
  const digest = artifactAdmissionDigest(binding as never);
  const reference = { bindingDigest: digest };
  const delivery = {
    deliveryId: 'delivery',
    sessionId: 'session',
    recipients: [{ seatId: 'coder' }],
    status: 'awaiting_intervention',
    originalContent: content,
    deliveredContent: null,
    intervention: null,
  };
  const attempt = {
    attemptId: 'attempt',
    policyReservationId: 'policy',
    kind: 'fix',
    actorSeatId: 'coder',
    artifactRevision: 'commit',
    artifactHash: sha,
    dispatched: false,
    settled: false,
    binding: {
      deliveryId: 'delivery',
      contentHash: createHash('sha256').update(content).digest('hex'),
      configRevision: 2,
      membershipGeneration: 2,
      accountId: 'coder',
      model: 'offline',
      profileId: 'coder',
      profileRevision: '1',
      accountProfileRevision: '1',
    },
  };
  const stopped = {
    owner: 'owner',
    sessionId: 'session',
    decisionCode: 'user_stop',
    applicationAttempts: [attempt],
  };
  const reviews = {
    get: vi.fn(() => stopped),
    getApplicationPreparation: vi.fn(() => ({ ...writer, status: 'bound' })),
  };
  const control = {
    workflowId: 'flow',
    attemptId: 'attempt',
    policyReservationId: 'policy',
    epoch: 0,
    state: 'armed',
  };
  const events = {
    getActiveSymposiumConfig: vi.fn(() => ({
      version: 2,
      state: 'active',
      revision: 2,
      seats: [{ id: 'coder', role: 'coder' }],
    })),
    getLatestSymposiumMembership: vi.fn(() => ({
      state: 'active',
      reconciliation: 'confirmed',
      generation: 2,
    })),
    getSymposiumSealedReaderAdmission: vi.fn(),
    getSymposiumArtifactAdmission: vi.fn(() => ({
      binding,
      reference,
      receipt: {
        transitionId: 'fix-child',
        parentGenerationId: 'generation',
        bindingDigest: digest,
        sessionId: 'session',
      },
    })),
    getSymposiumDeliveryByIdempotencyKey: vi.fn(() => delivery),
    getSymposiumDelivery: vi.fn(() => delivery),
    getSymposiumRecipientAttempts: vi.fn(() => []),
    getSymposiumArtifactReference: vi.fn(() => reference),
    getSymposiumApplicationDeliveryControl: vi.fn(() => control),
    pauseSymposiumApplicationDelivery: vi.fn(() => {
      control.epoch = 1;
      control.state = 'held';
      return 1;
    }),
  };
  const cancelDelivery = vi.fn();
  const deps = {
    reviews: reviews as never,
    events: events as never,
    successorState: vi.fn(async () => 'active' as const),
    cancelDelivery,
  };
  expect(
    await reconcileStoppedApplicationPreparation(
      deps,
      { owner: 'owner', sessionId: 'session' },
      writer,
    ),
  ).toEqual({ kind: 'resumable', epoch: 1 });
  expect(events.pauseSymposiumApplicationDelivery).toHaveBeenCalledOnce();
  expect(cancelDelivery).not.toHaveBeenCalled();
  control.epoch = 0;
  control.state = 'armed';
  delivery.status = 'ready';
  delivery.deliveredContent = content;
  delivery.intervention = 'approve';
  expect(
    await reconcileStoppedApplicationPreparation(
      deps,
      { owner: 'owner', sessionId: 'session' },
      writer,
    ),
  ).toEqual({ kind: 'resumable', epoch: 1 });
  control.epoch = 0;
  control.state = 'armed';
  events.pauseSymposiumApplicationDelivery.mockImplementationOnce(() => {
    throw new Error('competing claim won');
  });
  expect(
    await reconcileStoppedApplicationPreparation(
      deps,
      { owner: 'owner', sessionId: 'session' },
      writer,
    ),
  ).toBeNull();
  events.getSymposiumRecipientAttempts.mockReturnValue([{}] as never);
  expect(
    await reconcileStoppedApplicationPreparation(
      deps,
      { owner: 'owner', sessionId: 'session' },
      writer,
    ),
  ).toBeNull();
});

it('reconciles a bound claim only with its exact staged delivery and no recipient attempt', async () => {
  const f = fixture(false);
  const content = 'offline review prompt';
  const attempt = {
    workflowId: prep.workflowId,
    attemptId: prep.attemptId,
    policyReservationId: prep.policyReservationId,
    kind: prep.kind,
    actorSeatId: prep.actorSeatId,
    artifactRevision: prep.artifactRevision,
    artifactHash: prep.artifactHash,
    binding: {
      claimToken: 'claim',
      deliveryId: 'delivery',
      contentHash: createHash('sha256').update(content).digest('hex'),
      membershipGeneration: 2,
      configRevision: 2,
      accountId: 'reviewer',
      model: 'offline',
      profileId: 'reviewer',
      profileRevision: '1',
      accountProfileRevision: '1',
      authorityGrant: { grantId: 'authority', revision: 1 },
      contextGrant: { grantId: 'context', revision: 1 },
    },
  };
  f.reviews.completeApplicationPreparation(attempt, {
    transitionId: prep.transitionId,
    sealDigest: prep.seal.sealDigest,
  });
  f.reviews.stopApplication('flow', 'owner', 'user_stop');
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
      bindingDigest: reference.bindingDigest,
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
    deliveryId: 'wrong-delivery',
    sessionId: 'session',
    recipients: [{ seatId: 'reviewer' }],
    status: 'awaiting_intervention',
    originalContent: content,
  } as never);
  const deps = {
    reviews: f.reviews,
    events: f.events as never,
    cancelDelivery: vi.fn(async () => ({ status: 'cancelled' })),
    successorState: vi.fn(),
  };
  expect(await reconcileStoppedApplicationPreparation(deps, f.context, prep)).toBeNull();
  f.events.getSymposiumDeliveryByIdempotencyKey.mockReturnValue({
    deliveryId: 'delivery',
    sessionId: 'session',
    recipients: [{ seatId: 'reviewer' }],
    status: 'awaiting_intervention',
    originalContent: content,
  } as never);
  f.events.getSymposiumRecipientAttempts.mockReturnValue([{}] as never);
  expect(await reconcileStoppedApplicationPreparation(deps, f.context, prep)).toBeNull();
  f.events.getSymposiumRecipientAttempts.mockReturnValue([]);
  expect(await reconcileStoppedApplicationPreparation(deps, f.context, prep)).toBe(
    'applied_no_dispatch',
  );
  expect(deps.cancelDelivery).toHaveBeenCalledOnce();
  f.reviews.close();
});
