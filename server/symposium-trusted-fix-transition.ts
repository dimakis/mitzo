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
import type {
  CompletedArtifactSeal,
  SuccessorArtifactExportReceipt,
} from './symposium-physical-artifact-seal.js';
import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';

type Transition = NonNullable<SymposiumTrustedReviewHostDeps['transition']>;
type Fix = ApplicationPreparation & { kind: 'fix' };
type Identity = { revision: string; hash: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => canonicalReviewJson(a) === canonicalReviewJson(b);
const sealDigest = (seal: CompletedArtifactSeal) => reviewRecordHash(canonicalReviewJson(seal));

/** A fix starts from the exact completed writer seal and the owner's exact open
 * finding intent. Only a charged preparation may cross into physical copy. */
export function createSealedFixReviewTransition(deps: {
  events: Pick<
    EventStore,
    | 'getActiveSymposiumConfig'
    | 'getLatestSymposiumMembership'
    | 'getSymposiumArtifactSealByFence'
    | 'assertSymposiumArtifactAdmissionCurrent'
  >;
  reviews: SymposiumReviewStore;
  grants: Pick<SymposiumHostGrants, 'verifySeat'>;
  workspace: string;
  currentArtifact(context: ReviewContext): Identity;
  sourceFence(context: ReviewContext, artifact: Identity): string;
  requireCompletedSeal(fenceId: string): Promise<CompletedArtifactSeal>;
  baseBranch(context: ReviewContext): string;
  inspect(
    input: { fenceId: string; operationId: string; baseBranch: string },
    signal: AbortSignal,
  ): Promise<{ sourceBranch: string; sourceOid: string }>;
  exportSuccessor(
    input: {
      fenceId: string;
      operationId: string;
      sourceBranch: string;
      baseBranch: string;
      sourceOid: string;
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<{ receipt: SuccessorArtifactExportReceipt; bundle: Buffer }>;
  currentPointer(
    context: ReviewContext,
    seatId: string,
    membershipGeneration: number,
  ): ArtifactAdmissionReferenceV1;
  copy(
    request: ArtifactGenerationRequest,
    receipt: SuccessorArtifactExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<ArtifactGenerationCopyReceipt>;
  activate(
    request: ArtifactGenerationRequest,
    generationId: string,
    receipt: SuccessorArtifactExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<{ generationId: string; revision: number }>;
  admit(
    request: ArtifactGenerationRequest,
    binding: ArtifactAdmissionBindingV1,
    receipt: SuccessorArtifactExportReceipt,
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
      throw new Error('Current fix coder authority required');
    deps.grants.verifySeat({
      sessionId: context.sessionId,
      seat,
      membershipGeneration: member.generation,
    });
    return { config, seat: seat as SeatConfig, member };
  };
  const parent = async (context: ReviewContext, artifact: Identity) => {
    if (!same(deps.currentArtifact(context), artifact)) throw new Error('Fix artifact changed');
    const fenceId = deps.sourceFence(context, artifact);
    const intent = deps.events.getSymposiumArtifactSealByFence(fenceId);
    const seal = await deps.requireCompletedSeal(fenceId);
    if (
      !intent ||
      intent.selection.sessionId !== context.sessionId ||
      seal.fenceId !== fenceId ||
      seal.sessionId !== context.sessionId ||
      seal.intentDigest !== hash(JSON.stringify(intent)) ||
      seal.git.commit !== artifact.revision ||
      seal.git.committedTreeDigest !== artifact.hash
    )
      throw new Error('Exact completed fix parent required');
    return { fenceId, intent, seal };
  };
  const exact = (context: ReviewContext, prep: Fix) => {
    const workflow = deps.reviews.get(prep.workflowId);
    const retained = deps.reviews.getApplicationPreparation(prep.workflowId, prep.attemptId);
    const prepared = retained && {
      workflowId: retained.workflowId,
      attemptId: retained.attemptId,
      policyReservationId: retained.policyReservationId,
      kind: retained.kind,
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
      workflow.status !== 'awaiting_fix' ||
      workflow.decisionCode ||
      !retained ||
      retained.status !== 'preparing' ||
      retained.kind !== 'fix' ||
      !same(prepared, prep)
    )
      throw new Error('Exact charged fix preparation required');
    const findings = workflow.findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => finding.fingerprint)
      .sort();
    const intents = workflow.applicationFixIntents.filter(
      (intent) =>
        intent.actor === context.owner &&
        intent.artifactRevision === prep.artifactRevision &&
        intent.artifactHash === prep.artifactHash &&
        same([...intent.findingFingerprints].sort(), findings),
    );
    if (!findings.length || intents.length !== 1)
      throw new Error('Exact owner-authorized fix finding scope required');
    return { workflow, findings };
  };
  return {
    async prepare(input) {
      if (input.kind !== 'fix') throw new Error('Fix transition kind required');
      const artifact = { revision: input.artifactRevision, hash: input.artifactHash };
      const { fenceId, intent, seal } = await parent(input.context, artifact);
      const { config, seat, member } = current(input.context, input.selection.seatId);
      if (
        input.selection.accountId !== seat.accountBinding!.accountId ||
        input.selection.model !== seat.accountBinding!.model ||
        input.selection.profileId !== seat.profileBinding!.profileId ||
        String(input.selection.profileRevision) !== seat.profileBinding!.profileRevision
      )
        throw new Error('Selected fix coder changed');
      const transitionId = `fix-${hash(`${input.workflowId}:${input.attemptId}:${fenceId}`)}`;
      return {
        workflowId: input.workflowId,
        attemptId: input.attemptId,
        policyReservationId: `policy-${hash(`${transitionId}:application`)}`,
        kind: 'fix',
        actorSeatId: seat.id,
        artifactRevision: artifact.revision,
        artifactHash: artifact.hash,
        transitionId,
        seal: {
          fenceId,
          artifactGenerationId: intent.selection.artifact.volumeGeneration,
          volumeName: intent.selection.artifact.volumeName,
          sealDigest: sealDigest(seal),
          artifactRevision: artifact.revision,
          artifactHash: artifact.hash,
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
      if (preparation.kind !== 'fix') throw new Error('Fix preparation required');
      const prep = preparation as Fix;
      const { workflow, findings } = exact(context, prep);
      const { config, seat, member } = current(context, prep.actorSeatId);
      const artifact = { revision: prep.artifactRevision, hash: prep.artifactHash };
      const { fenceId, intent, seal } = await parent(context, artifact);
      if (
        config.revision !== prep.from.configRevision ||
        member.generation !== prep.from.membershipGeneration ||
        fenceId !== prep.seal.fenceId ||
        sealDigest(seal) !== prep.seal.sealDigest ||
        intent.selection.artifact.volumeGeneration !== prep.seal.artifactGenerationId ||
        intent.selection.artifact.volumeName !== prep.seal.volumeName
      )
        throw new Error('Prepared fix parent changed');
      const pointer = deps.currentPointer(context, seat.id, member.generation);
      if (pointer.artifactGenerationId !== prep.seal.artifactGenerationId)
        throw new Error('Current fix generation pointer changed');
      const signal = AbortSignal.timeout(600_000);
      const baseBranch = deps.baseBranch(context);
      const inspection = await deps.inspect(
        { fenceId, operationId: prep.transitionId, baseBranch },
        signal,
      );
      if (inspection.sourceOid !== prep.artifactRevision)
        throw new Error('Sealed fix branch identity changed');
      const exported = await deps.exportSuccessor(
        {
          fenceId,
          operationId: prep.transitionId,
          sourceBranch: inspection.sourceBranch,
          sourceOid: inspection.sourceOid,
          baseBranch,
          maxBytes: 8 * 1024 * 1024,
        },
        signal,
      );
      const receipt = exported.receipt;
      if (
        receipt.mode !== 'successor' ||
        receipt.operationId !== prep.transitionId ||
        receipt.parentGenerationId !== prep.seal.artifactGenerationId ||
        receipt.parentVolumeName !== prep.seal.volumeName ||
        receipt.parentSealDigest !== prep.seal.sealDigest ||
        !same(receipt.seal, seal)
      )
        throw new Error('Retained fix successor export changed');
      const request: ArtifactGenerationRequest = {
        kind: 'fix',
        fixAttemptId: prep.attemptId,
        findingFingerprints: findings,
        sessionId: context.sessionId,
        workspace: deps.workspace,
        custodyDigest: seal.custodyDigest,
        operationId: prep.transitionId,
        expectedPointerRevision: pointer.pointerRevision,
        parentGenerationId: receipt.parentGenerationId,
        parentSealDigest: receipt.parentSealDigest,
        parentCommit: seal.git.commit,
        parentTree: seal.git.tree,
        parentManifestDigest: seal.git.manifestDigest,
        parentCommittedTreeDigest: seal.git.committedTreeDigest,
        bundleSha256: receipt.bundleSha256,
        exportReceiptDigest: reviewRecordHash(canonicalReviewJson(receipt)),
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
      const copied = await deps.copy(request, receipt, exported.bundle, signal);
      const activated = await deps.activate(
        request,
        copied.generationId,
        receipt,
        exported.bundle,
        signal,
      );
      if (
        activated.generationId !== copied.generationId ||
        activated.revision !== pointer.pointerRevision + 1
      )
        throw new Error('Fix child activation changed');
      const binding: ArtifactAdmissionBindingV1 = {
        version: 1,
        kind: 'fix',
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
        expectedPointerRevision: pointer.pointerRevision,
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
        parentFenceId: fenceId,
        fixAttemptId: prep.attemptId,
        findingFingerprints: findings,
      };
      const confirmed = await deps.admit(request, binding, receipt, exported.bundle, signal);
      if (
        !confirmed.receipt ||
        confirmed.reference.bindingDigest !== artifactAdmissionDigest(binding)
      )
        throw new Error('Confirmed fix child admission required');
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
        throw new Error('Fresh fix child provider admission required');
      const prompt = `Fix only the owner-authorized open findings for artifact ${prep.artifactRevision} (${prep.artifactHash}). Commit the resulting changes and report what changed; host verification determines completion. Task data:\n${JSON.stringify({ acceptanceCriteria: workflow.acceptanceCriteria, findings: workflow.findings.filter((finding) => findings.includes(finding.fingerprint)) })}`;
      const delivery = deps.runtime(context).stageDelivery({
        sessionId: context.sessionId,
        sourceSeatId: null,
        recipientSeatIds: [seat.id],
        originalContent: prompt,
        idempotencyKey: `fix-${prep.workflowId}-${prep.attemptId}`,
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
        throw new Error('Exact fix child delivery required');
      return {
        attempt: {
          workflowId: prep.workflowId,
          attemptId: prep.attemptId,
          policyReservationId: prep.policyReservationId,
          kind: 'fix',
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
