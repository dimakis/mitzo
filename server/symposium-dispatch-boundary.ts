import type {
  AccountBinding,
  ArtifactAdmissionReferenceV1,
  ArtifactReaderReferenceV1,
  SeatConfig,
  SymposiumConfig,
  SymposiumMembershipRecord,
  SymposiumAdmissionRecord,
} from '@mitzo/protocol';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';

/** Read-only projection of the durable admission facts needed at the last dispatch boundary. */
export interface SymposiumDispatchFacts {
  assertSymposiumArtifactWorkAllowed(
    sessionId: string,
    artifact?: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1 | null,
  ): void;
  getSymposiumArtifactReference?(
    sessionId: string,
    seatId: string,
    generation: number,
  ): ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1 | null;
  getActiveSymposiumConfig(sessionId: string): SymposiumConfig;
  getLatestSymposiumMembership(
    sessionId: string,
    seatId: string,
  ): SymposiumMembershipRecord | null | undefined;
  getLatestSymposiumAdmission(
    sessionId: string,
    seatId: string,
    revision: number,
  ): SymposiumAdmissionRecord | null | undefined;
  getSymposiumDelivery(deliveryId: string):
    | {
        sessionId: string;
        status: string;
        deliveredContent: string | null;
        recipients: Array<{
          seatId: string;
          status: string;
          idempotencyKey: string;
          membershipGeneration?: number;
        }>;
      }
    | null
    | undefined;
}

/** Trusted host registry; no client-supplied grant reference is sufficient authority. */
export interface SymposiumHostGrantVerifier {
  verifySeat(input: { sessionId: string; seat: SeatConfig; membershipGeneration: number }): void;
}

function sameBinding(left: AccountBinding, right: AccountBinding): boolean {
  return (
    left.provider === right.provider &&
    left.accountId === right.accountId &&
    left.model === right.model &&
    left.profileRevision === right.profileRevision
  );
}

function sameSeat(left: SeatConfig, right: SeatConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Shared durable authority fence. This does not attest a native sandbox or provider route. */
export function assertSymposiumSeatDispatchCurrent(
  facts: SymposiumDispatchFacts,
  input: SymposiumSeatExecution,
  hostGrants: SymposiumHostGrantVerifier,
): SeatConfig {
  input.signal.throwIfAborted();
  if ('version' in input.provenance && input.provenance.version === 3) {
    const retained = facts.getSymposiumArtifactReference?.(
      input.sessionId,
      input.seat.id,
      input.provenance.membershipGeneration,
    );
    if (!retained || JSON.stringify(retained) !== JSON.stringify(input.provenance.artifact))
      throw new Error('Exact current seat artifact reference required');
  }
  facts.assertSymposiumArtifactWorkAllowed(
    input.sessionId,
    'version' in input.provenance && input.provenance.version === 3
      ? input.provenance.artifact
      : undefined,
  );
  const config = facts.getActiveSymposiumConfig(input.sessionId);
  if (
    config.version !== 2 ||
    config.state !== 'active' ||
    config.revision !== input.provenance.configRevision
  )
    throw new Error('Symposium configuration changed before native dispatch');
  if (config.turnRules.mode === 'budgeted')
    throw new Error('Budgeted native execution requires a trusted provider cost reservation');
  const seat = config.seats.find((candidate) => candidate.id === input.seat.id);
  if (!seat || !sameSeat(seat, input.seat) || !seat.accountBinding || !seat.authorityGrant)
    throw new Error('Symposium seat binding changed before native dispatch');
  if (
    !('version' in input.provenance) ||
    (input.provenance.version !== 2 && input.provenance.version !== 3) ||
    !sameBinding(input.provenance.accountBinding, seat.accountBinding)
  )
    throw new Error('Symposium execution provenance does not match the seat');
  const generation = input.provenance.membershipGeneration;
  if (
    input.provenance.seatId !== seat.id ||
    input.provenance.seatLabel !== seat.name ||
    input.provenance.seatRole !== seat.role ||
    input.provenance.reasoningEffort !== (seat.reasoningEffort ?? null) ||
    input.provenance.profileBinding.profileId !== seat.profileBinding?.profileId ||
    input.provenance.profileBinding.profileRevision !== seat.profileBinding.profileRevision ||
    input.provenance.contextGrant.grantId !== seat.contextGrant?.grantId ||
    input.provenance.contextGrant.revision !== seat.contextGrant.revision ||
    input.provenance.authorityGrant.grantId !== seat.authorityGrant.grantId ||
    input.provenance.authorityGrant.revision !== seat.authorityGrant.revision ||
    input.provenance.isolationDomainId !== seat.isolationRequest?.trustDomainId ||
    input.provenance.isolationDomainRevision !== seat.isolationRequest.revision
  )
    throw new Error('Symposium execution provenance changed before native dispatch');
  const membership = facts.getLatestSymposiumMembership(input.sessionId, seat.id);
  if (
    generation === undefined ||
    membership?.generation !== generation ||
    membership.state !== 'active' ||
    membership.reconciliation !== 'confirmed'
  )
    throw new Error('Symposium membership is not current and confirmed');
  hostGrants.verifySeat({
    sessionId: input.sessionId,
    seat,
    membershipGeneration: generation,
  });
  const admission = facts.getLatestSymposiumAdmission(input.sessionId, seat.id, config.revision);
  if (
    admission?.decision !== 'admitted' ||
    admission.membershipGeneration !== generation ||
    admission.accountId !== seat.accountBinding.accountId ||
    admission.provider !== seat.accountBinding.provider ||
    admission.model !== seat.accountBinding.model ||
    admission.accountProfileRevision !== seat.accountBinding.profileRevision
  )
    throw new Error('Current-generation provider admission is missing');
  const delivery = facts.getSymposiumDelivery(input.deliveryId);
  const recipient = delivery?.recipients.find((candidate) => candidate.seatId === seat.id);
  if (
    delivery?.sessionId !== input.sessionId ||
    delivery.status !== 'delivering' ||
    delivery.deliveredContent !== input.content ||
    recipient?.status !== 'executing' ||
    recipient.idempotencyKey !== input.idempotencyKey ||
    recipient.membershipGeneration !== generation
  )
    throw new Error('Symposium recipient delivery changed before native dispatch');
  return seat;
}
