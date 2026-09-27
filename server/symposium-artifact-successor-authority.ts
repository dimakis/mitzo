import type { ArtifactGenerationRequest } from './symposium-artifact-generations.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
/** Host construction only: never accepted from a request or portable configuration.
 * The current verifier must check authenticated grant, membership, model/account/profile
 * and the exact enforced native fix reservation. Existing workflow rows alone are insufficient. */
export interface SuccessorFixAuthority {
  workflows: SymposiumReviewStore;
  assertCurrent(request: ArtifactGenerationRequest): true;
}
export function assertSuccessorFixAuthority(
  authority: SuccessorFixAuthority | undefined,
  request: ArtifactGenerationRequest,
): true {
  if (!authority) throw new Error('Trusted successor fix authority unavailable');
  if (authority.assertCurrent(request) !== true)
    throw new Error('Current successor fix authority required');
  const state = authority.workflows.get(request.workflowId);
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
  if (
    !state.authorizations.some(
      (value) =>
        value.actor === request.actor &&
        value.authorityGrantId === request.authorityGrantId &&
        value.authorityRevision === request.authorityRevision &&
        value.artifactRevision === state.artifactRevision &&
        value.artifactHash === state.artifactHash &&
        sameScope(value.findingFingerprints),
    ) ||
    request.findingFingerprints.some(
      (key) => !state.findings.some((f) => f.fingerprint === key && f.status === 'open'),
    ) ||
    !state.reservations.some(
      (value) =>
        value.kind === 'fix' &&
        value.attemptId === request.fixAttemptId &&
        !value.settled &&
        value.actorSeatId === request.seatId &&
        value.artifactRevision === state.artifactRevision &&
        value.artifactHash === state.artifactHash,
    )
  )
    throw new Error('Exact retained successor fix authorization and reservation required');
  return true;
}
