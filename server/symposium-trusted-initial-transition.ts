import { createHash, randomUUID } from 'node:crypto';
import type {
  ArtifactAdmissionBindingV1,
  ArtifactAdmissionReferenceV1,
  SeatConfig,
} from '@mitzo/protocol';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import type { EventStore } from './event-store.js';
import type { SymposiumHostGrants } from './symposium-host-grants.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import type { ApplicationPreparation, SymposiumReviewStore } from './symposium-review-workflows.js';
import type { SymposiumTrustedReviewHostDeps } from './symposium-trusted-review-host.js';
import type {
  ArtifactGenerationRequest,
  ArtifactGenerationCopyReceipt,
} from './symposium-artifact-generations.js';
import { successorCopierContract } from './symposium-artifact-successor-copy.js';
import type { InitialSourceExportReceipt } from './symposium-source-artifact-seal.js';
import { canonicalReviewJson } from './symposium-review-records.js';

type Transition = NonNullable<SymposiumTrustedReviewHostDeps['transition']>;
type Initial = Extract<ApplicationPreparation, { kind: 'initial' }>;
type Source = {
  receipt: {
    sessionId: string;
    operationId: string;
    volumeGeneration: string;
    volumeName: string;
    git: { commit: string; committedTreeDigest: string };
  };
  digest: string;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => canonicalReviewJson(a) === canonicalReviewJson(b);

/** First write authority is the confirmed child of the immutable imported source.
 * Preparation is pure; the charged workflow row must exist before copy starts. */
export function createSealedInitialReviewTransition(deps: {
  events: Pick<
    EventStore,
    | 'getActiveSymposiumConfig'
    | 'getLatestSymposiumMembership'
    | 'getSymposiumDelivery'
    | 'assertSymposiumArtifactAdmissionCurrent'
  >;
  reviews: SymposiumReviewStore;
  grants: Pick<SymposiumHostGrants, 'verifySeat'>;
  workspace: string;
  source: {
    requireSeal(sessionId: string): Source;
    initialExport(
      sessionId: string,
      operationId: string,
    ): {
      receipt: InitialSourceExportReceipt;
      bundle: Buffer;
    };
  };
  copy(
    request: ArtifactGenerationRequest,
    receipt: InitialSourceExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<ArtifactGenerationCopyReceipt>;
  activate(
    request: ArtifactGenerationRequest,
    generationId: string,
    receipt: InitialSourceExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<{ generationId: string; revision: number }>;
  admit(
    request: ArtifactGenerationRequest,
    binding: ArtifactAdmissionBindingV1,
    receipt: InitialSourceExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<{ reference: ArtifactAdmissionReferenceV1; receipt: unknown }>;
  runtime(
    context: ReviewContext,
  ): Pick<SymposiumOrchestrator, 'recordProviderAdmission' | 'stageDelivery'>;
}): Transition {
  const current = (context: ReviewContext, seatId: string) => {
    const config = deps.events.getActiveSymposiumConfig(context.sessionId);
    const seat = config?.seats.find((candidate) => candidate.id === seatId);
    const member = deps.events.getLatestSymposiumMembership(context.sessionId, seatId);
    if (
      config?.version !== 2 ||
      config.state !== 'active' ||
      !seat ||
      seat.role !== 'coder' ||
      !seat.accountBinding ||
      !seat.profileBinding ||
      !seat.authorityGrant ||
      !seat.contextGrant ||
      seat.authorityGrant.filesystem !== 'write' ||
      seat.authorityGrant.tools !== 'write' ||
      member?.state !== 'active' ||
      member.reconciliation !== 'confirmed'
    )
      throw new Error('Current initial coder authority required');
    deps.grants.verifySeat({
      sessionId: context.sessionId,
      seat,
      membershipGeneration: member.generation,
    });
    return { config, seat: seat as SeatConfig, member };
  };
  const source = (context: ReviewContext) => {
    const sealed = deps.source.requireSeal(context.sessionId);
    if (sealed.receipt.sessionId !== context.sessionId)
      throw new Error('Imported source session changed');
    return sealed;
  };
  const exact = (context: ReviewContext, prep: Initial) => {
    const workflow = deps.reviews.get(prep.workflowId);
    const retained = deps.reviews.getApplicationPreparation(prep.workflowId, prep.attemptId);
    const prepared = retained && {
      workflowId: retained.workflowId,
      attemptId: retained.attemptId,
      policyReservationId: retained.policyReservationId,
      kind: retained.kind,
      sourceSealId: retained.kind === 'initial' ? retained.sourceSealId : null,
      actorSeatId: retained.actorSeatId,
      artifactRevision: retained.artifactRevision,
      artifactHash: retained.artifactHash,
      transitionId: retained.transitionId,
      seal: retained.seal,
      from: retained.from,
      to: retained.to,
      expectedSelection: retained.expectedSelection,
    };
    if (
      !workflow ||
      workflow.owner !== context.owner ||
      workflow.sessionId !== context.sessionId ||
      workflow.status !== 'awaiting_initial' ||
      workflow.implementation !== null ||
      workflow.decisionCode ||
      !retained ||
      retained.status !== 'preparing' ||
      retained.kind !== 'initial' ||
      !same(prepared, prep)
    )
      throw new Error('Exact charged initial preparation required');
    return workflow;
  };
  return {
    async prepare(input) {
      if (input.kind !== 'initial') throw new Error('Initial transition kind required');
      const sealed = source(input.context);
      const { config, seat, member } = current(input.context, input.selection.seatId);
      if (
        sealed.receipt.git.commit !== input.artifactRevision ||
        sealed.receipt.git.committedTreeDigest !== input.artifactHash ||
        input.selection.accountId !== seat.accountBinding!.accountId ||
        input.selection.model !== seat.accountBinding!.model ||
        input.selection.profileId !== seat.profileBinding!.profileId ||
        String(input.selection.profileRevision) !== seat.profileBinding!.profileRevision
      )
        throw new Error('Selected initial source changed');
      const transitionId = `initial-${hash(`${input.workflowId}:${input.attemptId}:${sealed.receipt.operationId}`)}`;
      return {
        workflowId: input.workflowId,
        attemptId: input.attemptId,
        policyReservationId: `policy-${hash(`${transitionId}:application`)}`,
        kind: 'initial',
        sourceSealId: sealed.receipt.operationId,
        actorSeatId: seat.id,
        artifactRevision: input.artifactRevision,
        artifactHash: input.artifactHash,
        transitionId,
        seal: {
          fenceId: sealed.receipt.operationId,
          artifactGenerationId: sealed.receipt.volumeGeneration,
          volumeName: sealed.receipt.volumeName,
          sealDigest: sealed.digest,
          artifactRevision: input.artifactRevision,
          artifactHash: input.artifactHash,
        },
        from: { configRevision: config.revision, membershipGeneration: member.generation },
        to: { configRevision: config.revision + 1, membershipGeneration: member.generation + 1 },
        expectedSelection: {
          accountId: seat.accountBinding!.accountId,
          model: seat.accountBinding!.model,
          profileId: seat.profileBinding!.profileId,
          profileRevision: seat.profileBinding!.profileRevision,
          accountProfileRevision: seat.accountBinding!.profileRevision,
        },
      };
    },
    async apply(context, preparation) {
      if (preparation.kind !== 'initial') throw new Error('Initial preparation required');
      const prep = preparation;
      const workflow = exact(context, prep);
      const sealed = source(context);
      const { config, seat, member } = current(context, prep.actorSeatId);
      if (
        config.revision !== prep.from.configRevision ||
        member.generation !== prep.from.membershipGeneration ||
        sealed.receipt.operationId !== prep.sourceSealId ||
        sealed.digest !== prep.seal.sealDigest ||
        sealed.receipt.volumeGeneration !== prep.seal.artifactGenerationId ||
        sealed.receipt.volumeName !== prep.seal.volumeName ||
        sealed.receipt.git.commit !== prep.artifactRevision ||
        sealed.receipt.git.committedTreeDigest !== prep.artifactHash ||
        workflow.initialArtifact?.revision !== prep.artifactRevision ||
        workflow.initialArtifact.hash !== prep.artifactHash
      )
        throw new Error('Prepared initial source changed');
      const exported = deps.source.initialExport(context.sessionId, prep.transitionId);
      const receipt = exported.receipt;
      if (
        receipt.mode !== 'initial' ||
        receipt.sourceSealId !== prep.sourceSealId ||
        receipt.parentSealDigest !== prep.seal.sealDigest ||
        receipt.parentGenerationId !== prep.seal.artifactGenerationId ||
        receipt.seal.git.commit !== prep.artifactRevision ||
        receipt.seal.git.committedTreeDigest !== prep.artifactHash
      )
        throw new Error('Retained initial export changed');
      const request: ArtifactGenerationRequest = {
        kind: 'initial',
        sourceSealId: prep.sourceSealId,
        initialAttemptId: prep.attemptId,
        policyReservationId: prep.policyReservationId,
        expectedConfigRevision: prep.from.configRevision,
        predecessorMembershipGeneration: prep.from.membershipGeneration,
        accountBinding: seat.accountBinding!,
        contextGrant: {
          grantId: seat.contextGrant!.grantId,
          revision: seat.contextGrant!.revision,
        },
        sessionId: context.sessionId,
        workspace: deps.workspace,
        custodyDigest: receipt.seal.custodyDigest,
        operationId: prep.transitionId,
        expectedPointerRevision: 0,
        parentGenerationId: receipt.parentGenerationId,
        parentSealDigest: receipt.parentSealDigest,
        parentCommit: receipt.seal.git.commit,
        parentTree: receipt.seal.git.tree,
        parentManifestDigest: receipt.seal.git.manifestDigest,
        parentCommittedTreeDigest: receipt.seal.git.committedTreeDigest,
        bundleSha256: receipt.bundleSha256,
        exportReceiptDigest: hash(canonicalReviewJson(receipt)),
        workflowId: prep.workflowId,
        actor: context.owner,
        authorityGrantId: seat.authorityGrant!.grantId,
        authorityRevision: seat.authorityGrant!.revision,
        seatId: seat.id,
        membershipGeneration: member.generation,
        accountId: seat.accountBinding!.accountId,
        model: seat.accountBinding!.model,
        profileId: seat.profileBinding!.profileId,
        profileRevision: seat.profileBinding!.profileRevision,
        ...successorCopierContract(),
      };
      const signal = AbortSignal.timeout(600_000);
      const copied = await deps.copy(request, receipt, exported.bundle, signal);
      const activated = await deps.activate(
        request,
        copied.generationId,
        receipt,
        exported.bundle,
        signal,
      );
      if (activated.generationId !== copied.generationId || activated.revision !== 1)
        throw new Error('Initial child activation changed');
      const binding: ArtifactAdmissionBindingV1 = {
        version: 1,
        kind: 'initial',
        transitionId: prep.transitionId,
        operationId: prep.transitionId,
        sessionId: context.sessionId,
        workspaceId: deps.workspace,
        custodyDigest: request.custodyDigest,
        parentGenerationId: request.parentGenerationId,
        parentSealDigest: request.parentSealDigest,
        childGenerationId: copied.generationId,
        childVolumeName: copied.volumeName,
        copyReceiptDigest: artifactAdmissionDigest(copied),
        expectedPointerRevision: 0,
        activatedPointerRevision: activated.revision,
        workflowId: prep.workflowId,
        policyReservationId: prep.policyReservationId,
        seatId: seat.id,
        actor: context.owner,
        expectedConfigRevision: prep.from.configRevision,
        resultingConfigRevision: prep.to.configRevision,
        predecessorMembershipGeneration: prep.from.membershipGeneration,
        successorMembershipGeneration: prep.to.membershipGeneration,
        accountBinding: seat.accountBinding!,
        profileBinding: seat.profileBinding!,
        contextGrant: {
          grantId: seat.contextGrant!.grantId,
          revision: seat.contextGrant!.revision,
        },
        authorityGrant: {
          grantId: seat.authorityGrant!.grantId,
          revision: seat.authorityGrant!.revision,
        },
        sourceSealId: prep.sourceSealId,
        initialAttemptId: prep.attemptId,
      };
      const confirmed = await deps.admit(request, binding, receipt, exported.bundle, signal);
      if (
        !confirmed.receipt ||
        confirmed.reference.bindingDigest !== artifactAdmissionDigest(binding)
      )
        throw new Error('Confirmed initial child admission required');
      deps.events.assertSymposiumArtifactAdmissionCurrent(context.sessionId, confirmed.reference);
      const admission = deps.runtime(context).recordProviderAdmission({
        sessionId: context.sessionId,
        seatId: seat.id,
        decision: 'admitted',
        idempotencyKey: `admit-${prep.transitionId}`,
      });
      if (
        admission.decision !== 'admitted' ||
        admission.configRevision !== prep.to.configRevision ||
        admission.membershipGeneration !== prep.to.membershipGeneration
      )
        throw new Error('Fresh initial child provider admission required');
      const prompt = `Implement the acceptance contract for imported artifact ${prep.artifactRevision} (${prep.artifactHash}). Commit the changes and report what changed; host verification determines completion. Task data:\n${JSON.stringify({ acceptanceCriteria: workflow.acceptanceCriteria })}`;
      const delivery = deps.runtime(context).stageDelivery({
        sessionId: context.sessionId,
        sourceSeatId: null,
        recipientSeatIds: [seat.id],
        originalContent: prompt,
        idempotencyKey: `initial-${prep.workflowId}-${prep.attemptId}`,
      });
      const recipient = delivery.recipients[0];
      if (
        delivery.sessionId !== context.sessionId ||
        delivery.status !== 'awaiting_intervention' ||
        delivery.originalContent !== prompt ||
        delivery.recipients.length !== 1 ||
        recipient.seatId !== seat.id ||
        delivery.configRevision !== prep.to.configRevision ||
        recipient.membershipGeneration !== prep.to.membershipGeneration ||
        recipient.accountProfileRevision !== seat.accountBinding!.profileRevision ||
        recipient.seatProfileRevision !== seat.profileBinding!.profileRevision ||
        recipient.authorityGrantId !== seat.authorityGrant!.grantId ||
        recipient.authorityGrantRevision !== seat.authorityGrant!.revision ||
        recipient.contextGrantId !== seat.contextGrant!.grantId ||
        recipient.contextGrantRevision !== seat.contextGrant!.revision
      )
        throw new Error('Exact initial child delivery required');
      return {
        attempt: {
          workflowId: prep.workflowId,
          attemptId: prep.attemptId,
          policyReservationId: prep.policyReservationId,
          kind: 'initial',
          actorSeatId: seat.id,
          artifactRevision: prep.artifactRevision,
          artifactHash: prep.artifactHash,
          binding: {
            claimToken: randomUUID(),
            deliveryId: delivery.deliveryId,
            contentHash: hash(prompt),
            membershipGeneration: prep.to.membershipGeneration,
            configRevision: prep.to.configRevision,
            accountId: seat.accountBinding!.accountId,
            model: seat.accountBinding!.model,
            profileId: seat.profileBinding!.profileId,
            profileRevision: seat.profileBinding!.profileRevision,
            accountProfileRevision: seat.accountBinding!.profileRevision,
            authorityGrant: {
              grantId: seat.authorityGrant!.grantId,
              revision: seat.authorityGrant!.revision,
            },
            contextGrant: {
              grantId: seat.contextGrant!.grantId,
              revision: seat.contextGrant!.revision,
            },
          },
        },
        proof: { transitionId: prep.transitionId, sealDigest: prep.seal.sealDigest },
      };
    },
  };
}
