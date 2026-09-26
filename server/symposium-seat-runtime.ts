import { createHash } from 'node:crypto';
import type {
  AccountBinding,
  SeatConfig,
  SymposiumConfig,
  SymposiumMembershipRecord,
  SymposiumAdmissionRecord,
} from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';

/** Read-only projection of the durable admission facts needed at the last dispatch boundary. */
export interface SymposiumDispatchFacts {
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

export type SymposiumSeatRoute =
  | {
      kind: 'openai-api';
      provider: string;
      providerId: string;
      model: string;
      effort: string | null;
      readOnly: boolean;
    }
  | {
      kind: 'claude-vertex';
      provider: string;
      providerId: string;
      model: string;
      effort: string | null;
      projectId: string;
      region: string;
      readOnly: boolean;
    };

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

/** A restored seat never resumes its predecessor's provider thread. */
export function symposiumSeatRuntimeId(input: SymposiumSeatExecution): string {
  const generation = input.provenance.membershipGeneration;
  if (generation === undefined)
    throw new Error('Native Symposium execution requires membership generation');
  const key = JSON.stringify([
    input.sessionId,
    input.seat.id,
    generation,
    input.seat.accountBinding,
    input.seat.reasoningEffort ?? null,
    input.seat.profileBinding,
    input.seat.contextGrant,
    input.seat.authorityGrant,
    input.seat.isolationRequest,
  ]);
  return `symposium:${createHash('sha256').update(key).digest('hex')}`;
}

/** Synchronous final fence: call immediately before the native provider operation. */
export function admitSymposiumSeatDispatch(
  facts: SymposiumDispatchFacts,
  profiles: AccountProfiles,
  input: SymposiumSeatExecution,
  hostGrants: SymposiumHostGrantVerifier,
): SymposiumSeatRoute {
  input.signal.throwIfAborted();
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
    input.provenance.version !== 2 ||
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
  profiles.resume(seat.accountBinding);
  profiles.validateModelSelection(
    seat.accountBinding,
    seat.accountBinding.model,
    seat.reasoningEffort,
  );
  if (seat.authorityGrant.filesystem === 'none' || seat.authorityGrant.tools === 'none')
    throw new Error('Native seat route cannot enforce a no-tool authority grant');
  const readOnly =
    seat.role === 'reviewer' ||
    seat.authorityGrant.filesystem !== 'write' ||
    seat.authorityGrant.tools !== 'write';
  const common = {
    model: seat.accountBinding.model,
    effort: seat.reasoningEffort ?? null,
    readOnly,
  };
  if (seat.accountBinding.provider === 'openai') {
    const profile = profiles.apiProfile(seat.accountBinding);
    if (!profile.sandboxProvider || !profile.sandboxProviderId)
      throw new Error('OpenAI seat lacks a pinned OpenShell account provider');
    return {
      kind: 'openai-api',
      provider: profile.sandboxProvider,
      providerId: profile.sandboxProviderId,
      ...common,
    };
  }
  if (seat.accountBinding.provider === 'anthropic-vertex') {
    const route = profiles.vertexSandboxRoute(seat.accountBinding);
    return { kind: 'claude-vertex', ...route, ...common };
  }
  throw new Error('Symposium native route does not support this account provider');
}
