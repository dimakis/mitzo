import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import type { EventStore } from './event-store.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import type { ApplicationPreparation, SymposiumReviewStore } from './symposium-review-workflows.js';
import { canonicalReviewJson } from './symposium-review-records.js';
import { createHash } from 'node:crypto';

type SuccessorState =
  'absent' | 'reserved' | 'copy_uncertain' | 'quarantined' | 'verified' | 'active' | null;
type EventReads = Pick<
  EventStore,
  | 'getActiveSymposiumConfig'
  | 'getLatestSymposiumMembership'
  | 'getSymposiumSealedReaderAdmission'
  | 'getSymposiumArtifactAdmission'
  | 'getSymposiumDeliveryByIdempotencyKey'
  | 'getSymposiumDelivery'
  | 'getSymposiumRecipientAttempts'
  | 'getSymposiumArtifactReference'
  | 'getSymposiumApplicationDeliveryControl'
  | 'pauseSymposiumApplicationDelivery'
>;
const same = (a: unknown, b: unknown) => canonicalReviewJson(a) === canonicalReviewJson(b);
const exactFields = (p: ApplicationPreparation) => ({
  workflowId: p.workflowId,
  attemptId: p.attemptId,
  policyReservationId: p.policyReservationId,
  kind: p.kind,
  sourceSealId: p.kind === 'initial' ? p.sourceSealId : null,
  actorSeatId: p.actorSeatId,
  artifactRevision: p.artifactRevision,
  artifactHash: p.artifactHash,
  transitionId: p.transitionId,
  seal: p.seal,
  from: p.from,
  to: p.to,
  expectedSelection: p.expectedSelection,
});

/** Inspect retained owners after the stop fence. An uncertain copy, lease,
 * delivery, claim or changed authority returns null and keeps preparing fenced. */
export async function reconcileStoppedApplicationPreparation(
  deps: {
    reviews: SymposiumReviewStore;
    events: EventReads;
    successorState(preparation: ApplicationPreparation, sessionId: string): Promise<SuccessorState>;
    cancelDelivery(
      deliveryId: string,
      idempotencyKey: string,
      applicationControl: { workflowId: string; attemptId: string; policyReservationId: string },
    ): Promise<{ status: string }>;
  },
  context: ReviewContext,
  preparation: ApplicationPreparation,
): Promise<'not_applied' | 'applied_no_dispatch' | { kind: 'resumable'; epoch: number } | null> {
  const state = deps.reviews.get(preparation.workflowId);
  const retained = deps.reviews.getApplicationPreparation(
    preparation.workflowId,
    preparation.attemptId,
  );
  if (
    !state?.decisionCode ||
    state.owner !== context.owner ||
    state.sessionId !== context.sessionId ||
    !retained ||
    (retained.status !== 'preparing' && retained.status !== 'bound') ||
    !same(exactFields(retained), exactFields(preparation))
  )
    return null;
  const bound = retained.status === 'bound';
  const attempt = state.applicationAttempts.find(
    (item) => item.attemptId === preparation.attemptId,
  );
  if (
    bound
      ? !attempt ||
        attempt.dispatched ||
        attempt.settled ||
        attempt.policyReservationId !== preparation.policyReservationId ||
        attempt.kind !== preparation.kind ||
        attempt.actorSeatId !== preparation.actorSeatId ||
        attempt.artifactRevision !== preparation.artifactRevision ||
        attempt.artifactHash !== preparation.artifactHash ||
        attempt.binding.configRevision !== preparation.to.configRevision ||
        attempt.binding.membershipGeneration !== preparation.to.membershipGeneration ||
        attempt.binding.accountId !== preparation.expectedSelection.accountId ||
        attempt.binding.model !== preparation.expectedSelection.model ||
        attempt.binding.profileId !== preparation.expectedSelection.profileId ||
        attempt.binding.profileRevision !== preparation.expectedSelection.profileRevision ||
        attempt.binding.accountProfileRevision !==
          preparation.expectedSelection.accountProfileRevision
      : Boolean(attempt)
  )
    return null;
  const config = deps.events.getActiveSymposiumConfig(context.sessionId);
  const seat = config.seats.find((candidate) => candidate.id === preparation.actorSeatId);
  const member = deps.events.getLatestSymposiumMembership(
    context.sessionId,
    preparation.actorSeatId,
  );
  if (
    config.version !== 2 ||
    config.state !== 'active' ||
    !seat ||
    seat.role !==
      (preparation.kind === 'review' || preparation.kind === 'delta' ? 'reviewer' : 'coder') ||
    !member ||
    member.state !== 'active' ||
    member.reconciliation !== 'confirmed'
  )
    return null;
  const reader = preparation.kind === 'review' || preparation.kind === 'delta';
  const record = reader
    ? deps.events.getSymposiumSealedReaderAdmission(context.sessionId, preparation.transitionId)
    : deps.events.getSymposiumArtifactAdmission(context.sessionId, preparation.transitionId);
  const prefix = preparation.kind === 'initial' ? 'initial' : reader ? 'review' : 'fix';
  const delivery = deps.events.getSymposiumDeliveryByIdempotencyKey(
    context.sessionId,
    `${prefix}-${preparation.workflowId}-${preparation.attemptId}`,
  );
  if (
    delivery &&
    (!(
      bound && !reader
        ? ['awaiting_intervention', 'ready', 'delivering', 'recovery_required', 'cancelled']
        : ['awaiting_intervention', 'cancelled']
    ).includes(delivery.status) ||
      deps.events.getSymposiumRecipientAttempts(delivery.deliveryId).length !== 0)
  )
    return null;
  if (
    bound &&
    (!delivery ||
      delivery.deliveryId !== attempt!.binding.deliveryId ||
      delivery.sessionId !== context.sessionId ||
      delivery.recipients.length !== 1 ||
      delivery.recipients[0].seatId !== preparation.actorSeatId ||
      typeof delivery.originalContent !== 'string' ||
      createHash('sha256').update(delivery.originalContent, 'utf8').digest('hex') !==
        attempt!.binding.contentHash)
  )
    return null;
  if (!record) {
    if (
      bound ||
      delivery ||
      config.revision !== preparation.from.configRevision ||
      member.generation !== preparation.from.membershipGeneration
    )
      return null;
    if (!reader) {
      const successor = await deps.successorState(preparation, context.sessionId);
      if (successor !== 'absent' && successor !== 'reserved') return null;
    }
    return 'not_applied';
  }
  if (!record.receipt) return null;
  const binding = record.binding;
  const bindingDigest = artifactAdmissionDigest(binding);
  if (
    binding.sessionId !== context.sessionId ||
    binding.workflowId !== preparation.workflowId ||
    binding.policyReservationId !== preparation.policyReservationId ||
    binding.seatId !== preparation.actorSeatId ||
    binding.operationId !== preparation.transitionId ||
    binding.expectedConfigRevision !== preparation.from.configRevision ||
    binding.resultingConfigRevision !== preparation.to.configRevision ||
    config.revision !== preparation.to.configRevision ||
    member.generation !== preparation.to.membershipGeneration ||
    record.reference.bindingDigest !== bindingDigest ||
    record.receipt.bindingDigest !== bindingDigest ||
    record.receipt.sessionId !== context.sessionId
  )
    return null;
  if (reader) {
    if (
      !('readerAdmissionId' in record.receipt) ||
      record.receipt.readerAdmissionId !== preparation.transitionId ||
      record.receipt.artifactGenerationId !== preparation.seal.artifactGenerationId ||
      record.receipt.seatId !== preparation.actorSeatId ||
      !('reviewAttemptId' in binding) ||
      binding.reviewAttemptId !== preparation.attemptId ||
      binding.readerAdmissionId !== preparation.transitionId ||
      binding.sealFenceId !== preparation.seal.fenceId ||
      binding.sealDigest !== preparation.seal.sealDigest ||
      binding.artifactGenerationId !== preparation.seal.artifactGenerationId ||
      binding.readerMembershipGeneration !== preparation.to.membershipGeneration
    )
      return null;
  } else {
    if (
      !('transitionId' in record.receipt) ||
      record.receipt.transitionId !== preparation.transitionId ||
      record.receipt.parentGenerationId !== preparation.seal.artifactGenerationId ||
      !('transitionId' in binding) ||
      binding.transitionId !== preparation.transitionId ||
      binding.parentGenerationId !== preparation.seal.artifactGenerationId ||
      binding.parentSealDigest !== preparation.seal.sealDigest ||
      binding.successorMembershipGeneration !== preparation.to.membershipGeneration ||
      (preparation.kind === 'initial'
        ? binding.kind !== 'initial' || binding.initialAttemptId !== preparation.attemptId
        : binding.kind !== 'fix' || binding.fixAttemptId !== preparation.attemptId)
    )
      return null;
    if ((await deps.successorState(preparation, context.sessionId)) !== 'active') return null;
  }
  const reference = deps.events.getSymposiumArtifactReference(
    context.sessionId,
    preparation.actorSeatId,
    preparation.to.membershipGeneration,
  );
  if (!reference || !same(reference, record.reference)) return null;
  if (
    bound &&
    !reader &&
    delivery &&
    ['awaiting_intervention', 'ready', 'delivering', 'recovery_required'].includes(delivery.status)
  ) {
    if (
      delivery.status !== 'awaiting_intervention' &&
      (delivery.intervention !== 'approve' ||
        delivery.deliveredContent !== delivery.originalContent ||
        delivery.recipients.some((recipient) => recipient.status !== 'pending'))
    )
      return null;
    const control = deps.events.getSymposiumApplicationDeliveryControl(delivery.deliveryId);
    if (
      !control ||
      control.workflowId !== preparation.workflowId ||
      control.attemptId !== preparation.attemptId ||
      control.policyReservationId !== preparation.policyReservationId ||
      (control.epoch !== (preparation.resumeEpoch ?? 0) &&
        !(control.epoch === (preparation.resumeEpoch ?? 0) + 1 && control.state === 'held'))
    )
      return null;
    let epoch: number;
    try {
      epoch = deps.events.pauseSymposiumApplicationDelivery({
        deliveryId: delivery.deliveryId,
        expectedEpoch: preparation.resumeEpoch ?? 0,
      });
    } catch {
      return null;
    }
    const paused = deps.events.getSymposiumApplicationDeliveryControl(delivery.deliveryId);
    if (
      !paused ||
      paused.epoch !== epoch ||
      paused.state !== 'held' ||
      paused.workflowId !== preparation.workflowId ||
      paused.attemptId !== preparation.attemptId ||
      paused.policyReservationId !== preparation.policyReservationId ||
      deps.events.getSymposiumDelivery(delivery.deliveryId)?.status !==
        (delivery.status === 'delivering' || delivery.status === 'recovery_required'
          ? 'ready'
          : delivery.status) ||
      deps.events.getSymposiumRecipientAttempts(delivery.deliveryId).length !== 0
    )
      return null;
    return { kind: 'resumable', epoch };
  }
  if (delivery?.status === 'awaiting_intervention') {
    const cancelled = await deps.cancelDelivery(
      delivery.deliveryId,
      `review-stop-preparation:${preparation.policyReservationId}`,
      {
        workflowId: preparation.workflowId,
        attemptId: preparation.attemptId,
        policyReservationId: preparation.policyReservationId,
      },
    );
    if (cancelled.status !== 'cancelled') return null;
    if (deps.events.getSymposiumRecipientAttempts(delivery.deliveryId).length !== 0) return null;
  }
  return 'applied_no_dispatch';
}
