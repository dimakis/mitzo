import type { ArtifactAdmissionBindingV1, SeatConfig } from '@mitzo/protocol';
import type { ArtifactGenerationRequest } from './symposium-artifact-generations.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
import type { EventStore } from './event-store.js';
import type { SymposiumHostGrants } from './symposium-host-grants.js';
import { canonicalReviewJson } from './symposium-review-records.js';
/** Host construction only: never accepted from a request or portable configuration.
 * The current verifier checks actual grant, membership, model/account/profile. The
 * workflow supplies either a native reservation or a charged application preparation. */
export interface SuccessorFixAuthority {
  workflows: SymposiumReviewStore;
  assertCurrent(request: ArtifactGenerationRequest): true;
  /** Checks the exact selected application reservation and before/after membership authority. */
  assertAdmissionCurrent?(binding: ArtifactAdmissionBindingV1): true;
}
/** Production owner verifier. User authorization is the retained fix intent; current
 * physical seat authority comes only from the active configuration and host grants. */
export function createSymposiumSuccessorFixAuthority(deps: {
  workflows: SymposiumReviewStore;
  events: Pick<
    EventStore,
    | 'getActiveSymposiumConfig'
    | 'getLatestSymposiumMembership'
    | 'getLatestSymposiumAdmission'
    | 'getSymposiumArtifactSealByFence'
    | 'withSymposiumHistoricalArtifactSealSnapshot'
  >;
  grants: Pick<SymposiumHostGrants, 'verifySeat'>;
}): SuccessorFixAuthority {
  const current = (
    sessionId: string,
    seatId: string,
    expectedGeneration?: number,
    requireSeatAdmission = false,
  ) => {
    const config = deps.events.getActiveSymposiumConfig(sessionId);
    const seat = config.seats.find((value) => value.id === seatId);
    const member = deps.events.getLatestSymposiumMembership(sessionId, seatId);
    const admission = deps.events.getLatestSymposiumAdmission(sessionId, seatId, config.revision);
    if (
      config.version !== 2 ||
      config.state !== 'active' ||
      !seat ||
      !seat.accountBinding ||
      !seat.profileBinding ||
      !seat.authorityGrant ||
      !seat.contextGrant ||
      seat.authorityGrant.filesystem !== 'write' ||
      seat.authorityGrant.tools !== 'write' ||
      !member ||
      member.state !== 'active' ||
      member.reconciliation !== 'confirmed' ||
      (expectedGeneration !== undefined && member.generation !== expectedGeneration) ||
      (requireSeatAdmission &&
        (admission?.decision !== 'admitted' ||
          admission.membershipGeneration !== member.generation ||
          admission.configRevision !== config.revision))
    )
      throw new Error('Current admitted writer authority required');
    deps.grants.verifySeat({ sessionId, seat, membershipGeneration: member.generation });
    return { config, seat: seat as SeatConfig, member };
  };
  const exactGrant = (seat: SeatConfig, binding: ArtifactAdmissionBindingV1) =>
    seat.authorityGrant?.grantId === binding.authorityGrant.grantId &&
    seat.authorityGrant.revision === binding.authorityGrant.revision &&
    seat.contextGrant?.grantId === binding.contextGrant.grantId &&
    seat.contextGrant.revision === binding.contextGrant.revision;
  return {
    workflows: deps.workflows,
    assertCurrent(request) {
      const { config, seat, member } = current(request.sessionId, request.seatId);
      if (
        member.generation !== request.membershipGeneration ||
        seat.accountBinding?.accountId !== request.accountId ||
        seat.accountBinding.model !== request.model ||
        seat.profileBinding?.profileId !== request.profileId ||
        seat.profileBinding.profileRevision !== request.profileRevision ||
        seat.authorityGrant?.grantId !== request.authorityGrantId ||
        seat.authorityGrant.revision !== request.authorityRevision
      )
        throw new Error('Current successor request selection changed');
      if (request.kind === 'initial') {
        const state = deps.workflows.get(request.workflowId);
        const prep = state?.applicationPreparations.find(
          (value) => value.kind === 'initial' && value.attemptId === request.initialAttemptId,
        );
        if (
          !state ||
          state.limits.mode !== 'application' ||
          state.status !== 'awaiting_initial' ||
          state.implementation !== null ||
          state.sessionId !== request.sessionId ||
          state.owner !== request.actor ||
          state.initialArtifact?.revision !== request.parentCommit ||
          state.initialArtifact.hash !== request.parentCommittedTreeDigest ||
          state.implementer.seatId !== request.seatId ||
          !prep ||
          prep.status !== 'preparing' ||
          prep.kind !== 'initial' ||
          prep.sourceSealId !== request.sourceSealId ||
          prep.policyReservationId !== request.policyReservationId ||
          prep.actorSeatId !== request.seatId ||
          prep.from.configRevision !== config.revision ||
          prep.from.membershipGeneration !== member.generation ||
          prep.seal.fenceId !== request.sourceSealId ||
          prep.seal.artifactGenerationId !== request.parentGenerationId ||
          prep.seal.sealDigest !== request.parentSealDigest ||
          prep.seal.artifactRevision !== request.parentCommit ||
          prep.seal.artifactHash !== request.parentCommittedTreeDigest ||
          prep.expectedSelection.accountId !== request.accountId ||
          prep.expectedSelection.model !== request.model ||
          prep.expectedSelection.profileId !== request.profileId ||
          prep.expectedSelection.profileRevision !== request.profileRevision ||
          prep.expectedSelection.accountProfileRevision !== request.accountBinding.profileRevision
        )
          throw new Error('Charged exact initial source preparation required');
        return true;
      }
      const admission = deps.events.getLatestSymposiumAdmission(
        request.sessionId,
        request.seatId,
        config.revision,
      );
      if (
        admission?.decision === 'admitted' &&
        admission.membershipGeneration === member.generation &&
        admission.configRevision === config.revision
      )
        return true;
      // A reader can advance the configuration while the sealed coder is stopped.
      // The exception is usable only for the exact charged fix preparation and an
      // immutable historical seal whose admission predates that reader transition.
      const state = deps.workflows.get(request.workflowId);
      const prep = state?.applicationPreparations.find(
        (value) => value.kind === 'fix' && value.attemptId === request.fixAttemptId,
      );
      const seal = prep && deps.events.getSymposiumArtifactSealByFence(prep.seal.fenceId);
      const predecessor = seal && seal.memberships.find((value) => value.seatId === request.seatId);
      const prior =
        seal &&
        deps.events.getLatestSymposiumAdmission(
          request.sessionId,
          request.seatId,
          seal.selection.expectedConfigRevision,
        );
      const sameFindings = (values: readonly string[]) =>
        values.length === request.findingFingerprints.length &&
        [...values].sort().join() === [...request.findingFingerprints].sort().join();
      if (
        !state ||
        state.limits.mode !== 'application' ||
        state.status !== 'awaiting_fix' ||
        state.sessionId !== request.sessionId ||
        state.owner !== request.actor ||
        state.artifactRevision !== request.parentCommit ||
        state.artifactHash !== request.parentCommittedTreeDigest ||
        !prep ||
        prep.status !== 'preparing' ||
        prep.actorSeatId !== request.seatId ||
        prep.from.configRevision !== config.revision ||
        prep.from.membershipGeneration !== member.generation ||
        prep.artifactRevision !== state.artifactRevision ||
        prep.artifactHash !== state.artifactHash ||
        prep.seal.artifactGenerationId !== request.parentGenerationId ||
        prep.seal.sealDigest !== request.parentSealDigest ||
        !state.applicationFixIntents.some(
          (value) =>
            value.actor === request.actor &&
            value.artifactRevision === state.artifactRevision &&
            value.artifactHash === state.artifactHash &&
            sameFindings(value.findingFingerprints),
        ) ||
        !seal ||
        seal.selection.sessionId !== request.sessionId ||
        seal.selection.artifact.volumeGeneration !== request.parentGenerationId ||
        !predecessor ||
        predecessor.generation !== member.generation ||
        predecessor.state !== 'active' ||
        predecessor.reconciliation !== 'confirmed' ||
        !prior ||
        prior.decision !== 'admitted' ||
        prior.configRevision !== seal.selection.expectedConfigRevision ||
        prior.membershipGeneration !== member.generation ||
        prior.provider !== seat.accountBinding?.provider ||
        prior.accountId !== request.accountId ||
        prior.model !== request.model ||
        prior.accountProfileRevision !== seat.accountBinding?.profileRevision
      )
        throw new Error('Current or sealed-predecessor admitted writer authority required');
      deps.events.withSymposiumHistoricalArtifactSealSnapshot(seal, () => {});
      return true;
    },
    assertAdmissionCurrent(binding) {
      if (binding.kind === 'initial') {
        const state = deps.workflows.get(binding.workflowId);
        const prep = state?.applicationPreparations.find(
          (value) =>
            value.kind === 'initial' &&
            value.attemptId === binding.initialAttemptId &&
            value.policyReservationId === binding.policyReservationId &&
            value.transitionId === binding.transitionId,
        );
        if (
          !state ||
          state.limits.mode !== 'application' ||
          state.sessionId !== binding.sessionId ||
          state.owner !== binding.actor ||
          !prep ||
          (prep.status !== 'preparing' && prep.status !== 'bound') ||
          prep.kind !== 'initial' ||
          prep.sourceSealId !== binding.sourceSealId ||
          prep.seal.fenceId !== binding.sourceSealId ||
          prep.seal.artifactGenerationId !== binding.parentGenerationId ||
          prep.seal.sealDigest !== binding.parentSealDigest ||
          prep.actorSeatId !== binding.seatId ||
          prep.from.configRevision !== binding.expectedConfigRevision ||
          prep.from.membershipGeneration !== binding.predecessorMembershipGeneration ||
          prep.to.configRevision !== binding.resultingConfigRevision ||
          prep.to.membershipGeneration !== binding.successorMembershipGeneration ||
          prep.expectedSelection.accountId !== binding.accountBinding.accountId ||
          prep.expectedSelection.model !== binding.accountBinding.model ||
          prep.expectedSelection.profileId !== binding.profileBinding.profileId ||
          prep.expectedSelection.profileRevision !== binding.profileBinding.profileRevision ||
          prep.expectedSelection.accountProfileRevision !== binding.accountBinding.profileRevision
        )
          throw new Error('Charged exact initial admission preparation required');
        const { config, seat, member } = current(binding.sessionId, binding.seatId);
        const before =
          prep.status === 'preparing' &&
          config.revision === binding.expectedConfigRevision &&
          member.generation === binding.predecessorMembershipGeneration;
        const after =
          config.revision === binding.resultingConfigRevision &&
          member.generation === binding.successorMembershipGeneration;
        if (
          !(before || after) ||
          canonicalReviewJson(seat.accountBinding) !==
            canonicalReviewJson(binding.accountBinding) ||
          canonicalReviewJson(seat.profileBinding) !==
            canonicalReviewJson(binding.profileBinding) ||
          !exactGrant(seat, binding)
        )
          throw new Error('Current initial writer authority changed');
        return true;
      }
      const state = deps.workflows.get(binding.workflowId);
      const prep = state?.applicationPreparations.find(
        (value) =>
          value.attemptId === binding.fixAttemptId &&
          value.policyReservationId === binding.policyReservationId &&
          value.transitionId === binding.transitionId,
      );
      if (
        !state ||
        state.limits.mode !== 'application' ||
        state.sessionId !== binding.sessionId ||
        state.owner !== binding.actor ||
        !prep ||
        prep.kind !== 'fix' ||
        (prep.status !== 'preparing' && prep.status !== 'bound') ||
        (prep.status === 'preparing' && state.status !== 'awaiting_fix') ||
        prep.actorSeatId !== binding.seatId ||
        (prep.status === 'preparing' &&
          (prep.artifactRevision !== state.artifactRevision ||
            prep.artifactHash !== state.artifactHash)) ||
        prep.seal.artifactGenerationId !== binding.parentGenerationId ||
        prep.seal.fenceId !== binding.parentFenceId ||
        prep.seal.sealDigest !== binding.parentSealDigest ||
        prep.from.configRevision !== binding.expectedConfigRevision ||
        prep.from.membershipGeneration !== binding.predecessorMembershipGeneration ||
        prep.to.configRevision !== binding.resultingConfigRevision ||
        prep.to.membershipGeneration !== binding.successorMembershipGeneration ||
        prep.expectedSelection.accountId !== binding.accountBinding.accountId ||
        prep.expectedSelection.model !== binding.accountBinding.model ||
        prep.expectedSelection.profileId !== binding.profileBinding.profileId ||
        prep.expectedSelection.profileRevision !== binding.profileBinding.profileRevision ||
        prep.expectedSelection.accountProfileRevision !== binding.accountBinding.profileRevision ||
        !state.applicationFixIntents.some(
          (intent) =>
            intent.actor === binding.actor &&
            intent.artifactRevision === prep.artifactRevision &&
            intent.artifactHash === prep.artifactHash &&
            canonicalReviewJson([...intent.findingFingerprints].sort()) ===
              canonicalReviewJson([...binding.findingFingerprints].sort()),
        )
      )
        throw new Error('Charged successor preparation and user fix intent required');
      const { config, seat, member } = current(binding.sessionId, binding.seatId);
      const before =
        config.revision === binding.expectedConfigRevision &&
        member.generation === binding.predecessorMembershipGeneration &&
        prep.status === 'preparing';
      const after =
        config.revision === binding.resultingConfigRevision &&
        member.generation === binding.successorMembershipGeneration;
      if (
        !(before || after) ||
        canonicalReviewJson(seat.accountBinding) !== canonicalReviewJson(binding.accountBinding) ||
        canonicalReviewJson(seat.profileBinding) !== canonicalReviewJson(binding.profileBinding) ||
        !exactGrant(seat, binding)
      )
        throw new Error('Current successor admission binding changed');
      if (prep.status === 'bound') {
        const admitted = state.applicationAttempts.find(
          (attempt) =>
            attempt.attemptId === prep.attemptId &&
            attempt.policyReservationId === prep.policyReservationId &&
            attempt.binding.configRevision === binding.resultingConfigRevision &&
            attempt.binding.membershipGeneration === binding.successorMembershipGeneration &&
            attempt.binding.authorityGrant.grantId === binding.authorityGrant.grantId &&
            attempt.binding.authorityGrant.revision === binding.authorityGrant.revision,
        );
        if (!admitted) throw new Error('Bound successor native claim required');
      }
      return true;
    },
  };
}
export function assertSuccessorFixAuthority(
  authority: SuccessorFixAuthority | undefined,
  request: ArtifactGenerationRequest,
): true {
  if (!authority) throw new Error('Trusted successor fix authority unavailable');
  if (authority.assertCurrent(request) !== true)
    throw new Error('Current successor fix authority required');
  const state = authority.workflows.get(request.workflowId);
  if (request.kind === 'initial') {
    const prep = state?.applicationPreparations?.find(
      (value) =>
        value.kind === 'initial' &&
        value.attemptId === request.initialAttemptId &&
        value.policyReservationId === request.policyReservationId,
    );
    if (
      !state ||
      state.limits.mode !== 'application' ||
      state.status !== 'awaiting_initial' ||
      state.implementation !== null ||
      state.sessionId !== request.sessionId ||
      state.owner !== request.actor ||
      state.initialArtifact?.revision !== request.parentCommit ||
      state.initialArtifact.hash !== request.parentCommittedTreeDigest ||
      state.implementer.seatId !== request.seatId ||
      state.implementer.accountId !== request.accountId ||
      state.implementer.model !== request.model ||
      state.implementer.profileId !== request.profileId ||
      String(state.implementer.profileRevision) !== request.profileRevision ||
      request.membershipGeneration !== request.predecessorMembershipGeneration ||
      request.accountBinding.accountId !== request.accountId ||
      request.accountBinding.model !== request.model ||
      !prep ||
      prep.status !== 'preparing' ||
      prep.kind !== 'initial' ||
      prep.sourceSealId !== request.sourceSealId ||
      prep.seal.artifactGenerationId !== request.parentGenerationId ||
      prep.seal.sealDigest !== request.parentSealDigest ||
      prep.artifactRevision !== request.parentCommit ||
      prep.artifactHash !== request.parentCommittedTreeDigest ||
      prep.from.membershipGeneration !== request.predecessorMembershipGeneration ||
      prep.from.configRevision !== request.expectedConfigRevision ||
      prep.actorSeatId !== request.seatId ||
      prep.expectedSelection.accountId !== request.accountId ||
      prep.expectedSelection.model !== request.model ||
      prep.expectedSelection.profileId !== request.profileId ||
      prep.expectedSelection.profileRevision !== request.profileRevision ||
      prep.expectedSelection.accountProfileRevision !== request.accountBinding.profileRevision
    )
      throw new Error('Exact retained initial attempt and policy reservation required');
    return true;
  }
  if (
    !state ||
    state.status !== 'awaiting_fix' ||
    state.sessionId !== request.sessionId ||
    state.owner !== request.actor ||
    state.artifactRevision !== request.parentCommit ||
    state.artifactHash !== request.parentCommittedTreeDigest ||
    state.implementer.seatId !== request.seatId ||
    state.implementer.accountId !== request.accountId ||
    state.implementer.model !== request.model ||
    state.implementer.profileId !== request.profileId ||
    String(state.implementer.profileRevision) !== request.profileRevision
  )
    throw new Error('Successor workflow or implementer authority changed');
  const sameScope = (values: readonly string[]) =>
    values.length === request.findingFingerprints.length &&
    [...values].sort().join() === [...request.findingFingerprints].sort().join();
  const nativeAuthorized =
    state.authorizations.some(
      (value) =>
        value.actor === request.actor &&
        value.authorityGrantId === request.authorityGrantId &&
        value.authorityRevision === request.authorityRevision &&
        value.artifactRevision === state.artifactRevision &&
        value.artifactHash === state.artifactHash &&
        sameScope(value.findingFingerprints),
    ) &&
    state.reservations.some(
      (value) =>
        value.kind === 'fix' &&
        value.attemptId === request.fixAttemptId &&
        !value.settled &&
        value.actorSeatId === request.seatId &&
        value.artifactRevision === state.artifactRevision &&
        value.artifactHash === state.artifactHash,
    );
  const applicationAuthorized =
    state.limits.mode === 'application' &&
    state.applicationFixIntents.some(
      (value) =>
        value.actor === request.actor &&
        value.artifactRevision === state.artifactRevision &&
        value.artifactHash === state.artifactHash &&
        sameScope(value.findingFingerprints),
    ) &&
    state.applicationPreparations.some(
      (value) =>
        value.kind === 'fix' &&
        value.status === 'preparing' &&
        value.attemptId === request.fixAttemptId &&
        value.actorSeatId === request.seatId &&
        value.artifactRevision === state.artifactRevision &&
        value.artifactHash === state.artifactHash &&
        value.expectedSelection.accountId === request.accountId &&
        value.expectedSelection.model === request.model &&
        value.expectedSelection.profileId === request.profileId &&
        value.expectedSelection.profileRevision === request.profileRevision,
    );
  if (
    request.findingFingerprints.some(
      (key) => !state.findings.some((f) => f.fingerprint === key && f.status === 'open'),
    ) ||
    !(nativeAuthorized || applicationAuthorized)
  )
    throw new Error('Exact retained successor fix authorization and reservation required');
  return true;
}
