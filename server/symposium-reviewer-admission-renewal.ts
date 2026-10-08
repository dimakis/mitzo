import type { EventStore } from './event-store.js';
import type { SymposiumHostGrants } from './symposium-host-grants.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
import type { ReviewContext } from './symposium-review-coordinator.js';

/** A writer admission advances the shared roster revision. Recheck each retained
 * read-only reviewer under that revision before the next review is selected. */
export function renewReviewerAdmissionAfterWriter(input: {
  context: ReviewContext;
  events: Pick<EventStore, 'getActiveSymposiumConfig' | 'getLatestSymposiumMembership'>;
  grants: Pick<SymposiumHostGrants, 'verifySeat'>;
  runtime: Pick<SymposiumOrchestrator, 'recordProviderAdmission'>;
  transitionId: string;
  expectedRevision: number;
}): void {
  const { context, events } = input;
  const config = events.getActiveSymposiumConfig(context.sessionId);
  if (
    config.version !== 2 ||
    config.state !== 'active' ||
    config.revision !== input.expectedRevision
  )
    throw new Error('Writer result revision changed before reviewer renewal');
  for (const seat of config.seats.filter((candidate) => candidate.role === 'reviewer')) {
    const member = events.getLatestSymposiumMembership(context.sessionId, seat.id);
    if (
      member?.state !== 'active' ||
      member.reconciliation !== 'confirmed' ||
      seat.authorityGrant?.filesystem !== 'read' ||
      seat.authorityGrant.tools !== 'read' ||
      !seat.accountBinding ||
      !seat.profileBinding ||
      !seat.contextGrant
    )
      throw new Error('Current read-only reviewer required after writer admission');
    input.grants.verifySeat({
      sessionId: context.sessionId,
      seat,
      membershipGeneration: member.generation,
    });
    const admission = input.runtime.recordProviderAdmission({
      sessionId: context.sessionId,
      seatId: seat.id,
      decision: 'admitted',
      idempotencyKey: `writer-reviewer:${input.transitionId}:${seat.id}:${member.generation}`,
    });
    if (
      admission.decision !== 'admitted' ||
      admission.configRevision !== config.revision ||
      admission.membershipGeneration !== member.generation
    )
      throw new Error('Fresh reviewer admission required after writer transition');
  }
}
