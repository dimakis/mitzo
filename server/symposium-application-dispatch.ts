import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import type { SymposiumApplicationDispatchPolicy } from './symposium-openshell-seat-executor.js';
import type { SymposiumNativeObservations } from './symposium-native-observations.js';
import type { ApplicationAttempt, SymposiumReviewStore } from './symposium-review-workflows.js';
import { canonicalReviewJson } from './symposium-review-records.js';

/** Joins existing durable workflow and native owners. Separate commits remain recoverable
 * uncertainty; neither a reservation nor a provider acceptance is a completion receipt. */
export function createSymposiumApplicationDispatchPolicy(deps: {
  store: SymposiumReviewStore;
  observations: Pick<SymposiumNativeObservations, 'get'> | undefined;
  assertArtifactCurrent(attempt: ApplicationAttempt, execution: SymposiumSeatExecution): void;
}): SymposiumApplicationDispatchPolicy {
  const selected = (input: SymposiumSeatExecution): ApplicationAttempt | null => {
    const workflow = deps.store.applicationWorkflowForSession(input.sessionId);
    const attempt = deps.store.applicationAttemptForClaim(input.claimToken);
    if (!workflow && !attempt) return null;
    if (!workflow || !attempt || attempt.workflowId !== workflow.workflowId)
      throw new Error('Exact application reservation required for this session');
    const seat = input.seat;
    if (!seat.accountBinding || !seat.profileBinding || !seat.contextGrant || !seat.authorityGrant)
      throw new Error('Application seat binding unavailable');
    const binding = {
      claimToken: input.claimToken,
      deliveryId: input.deliveryId,
      membershipGeneration: input.provenance.membershipGeneration,
      configRevision: input.provenance.configRevision,
      accountId: seat.accountBinding.accountId,
      model: seat.accountBinding.model,
      profileId: seat.profileBinding.profileId,
      profileRevision: seat.profileBinding.profileRevision,
      accountProfileRevision: seat.accountBinding.profileRevision,
      authorityGrant: {
        grantId: seat.authorityGrant.grantId,
        revision: seat.authorityGrant.revision,
      },
      contextGrant: { grantId: seat.contextGrant.grantId, revision: seat.contextGrant.revision },
    };
    if (
      attempt.actorSeatId !== seat.id ||
      canonicalReviewJson(binding) !== canonicalReviewJson(attempt.binding)
    )
      throw new Error('Application native execution binding changed');
    return attempt;
  };
  const observed = (input: SymposiumSeatExecution, thread?: string, turn?: string) => {
    const observation = deps.observations?.get(input.claimToken);
    if (
      !observation ||
      observation.terminalConflict ||
      observation.identity.sessionId !== input.sessionId ||
      observation.identity.seatId !== input.seat.id ||
      observation.identity.membershipGeneration !== input.provenance.membershipGeneration ||
      canonicalReviewJson(observation.identity.accountBinding) !==
        canonicalReviewJson(input.seat.accountBinding) ||
      canonicalReviewJson(observation.identity.provenance) !==
        canonicalReviewJson(input.provenance) ||
      (thread !== undefined && observation.identity.providerThreadId !== thread) ||
      (turn !== undefined && observation.identity.providerTurnId !== turn)
    )
      throw new Error('Exact native application observation required');
    return observation;
  };
  const operationId = (thread: string, turn: string) => canonicalReviewJson({ thread, turn });
  const assertCurrent = (input: SymposiumSeatExecution) => {
    const attempt = selected(input);
    if (!attempt) return;
    if (!deps.observations) throw new Error('Native application observation owner unavailable');
    deps.store.assertApplicationDispatch(attempt);
    deps.assertArtifactCurrent(attempt, input);
  };
  return {
    assertCurrent,
    consume(input) {
      assertCurrent(input);
      const attempt = selected(input);
      if (!attempt) return;
      const result = deps.store.consumeApplicationDispatch(attempt);
      if (result.kind !== 'dispatch_authorized') throw new Error(result.code);
    },
    accepted(input, thread, turn) {
      const attempt = selected(input);
      if (!attempt) return;
      // A stop racing provider acceptance does not erase the accepted operation.
      observed(input, thread, turn);
      deps.store.bindApplicationOperation(
        attempt.workflowId,
        attempt.attemptId,
        operationId(thread, turn),
      );
    },
    watch(input, requestCancellation) {
      const attempt = selected(input);
      if (!attempt) return () => undefined;
      let requested = false;
      const check = () => {
        if (requested) return;
        try {
          deps.store.assertApplicationDispatch(attempt);
        } catch {
          requested = true;
          requestCancellation();
        }
      };
      // A bounded watcher belongs to this executor call. It only observes persisted
      // stop/deadline state and requests exact cancellation; it never admits work.
      const timer = setInterval(check, 250);
      timer.unref?.();
      check();
      return () => clearInterval(timer);
    },
    completed(input) {
      const attempt = selected(input);
      if (!attempt) return;
      const observation = observed(input);
      if (observation.status !== 'completed' || observation.terminalAt === null)
        throw new Error('Trusted terminal application completion required');
      deps.store.settleApplicationExecution(
        attempt.workflowId,
        attempt.attemptId,
        operationId(observation.identity.providerThreadId, observation.identity.providerTurnId),
        'completed',
      );
    },
  };
}
