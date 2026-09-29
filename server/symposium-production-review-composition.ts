import { createHash } from 'node:crypto';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import type { ArtifactAdmissionReferenceV1 } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SymposiumProductionHost } from './app.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
import type { SymposiumHostGrants } from './symposium-host-grants.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
import type { SymposiumReviewActionAuthority } from './symposium-review-action-authority.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import { createOwnedReviewArtifactResults } from './symposium-owned-review-artifacts.js';
import { createOwnedCriterionReceipts } from './symposium-criterion-receipts.js';
import { createSealedInitialReviewTransition } from './symposium-trusted-initial-transition.js';
import { createSealedFixReviewTransition } from './symposium-trusted-fix-transition.js';
import { createSealedReaderReviewTransition } from './symposium-trusted-reader-transition.js';
import { createSymposiumTrustedReviewHost } from './symposium-trusted-review-host.js';
import { canonicalReviewJson } from './symposium-review-records.js';
import { reconcileStoppedApplicationPreparation } from './symposium-stopped-preparation.js';

type PhysicalHost = SymposiumProductionHost;
type Identity = { revision: string; hash: string };

/** A reviewer config advance makes the coder's admission historical. This
 * reads only the sealed pointer; fix dispatch still needs fresh child admission. */
export function historicalFixPointer(
  events: Pick<
    EventStore,
    | 'getActiveSymposiumConfig'
    | 'getLatestSymposiumMembership'
    | 'getSymposiumArtifactReference'
    | 'getSymposiumArtifactAdmission'
    | 'getSymposiumArtifactSealByFence'
    | 'withSymposiumHistoricalArtifactSealSnapshot'
  >,
  context: ReviewContext,
  seatId: string,
  membershipGeneration: number,
  generationId: string,
  fenceId: string,
): ArtifactAdmissionReferenceV1 {
  const config = events.getActiveSymposiumConfig(context.sessionId);
  const member = events.getLatestSymposiumMembership(context.sessionId, seatId);
  const ref = events.getSymposiumArtifactReference(context.sessionId, seatId, membershipGeneration);
  const record =
    ref && !('kind' in ref)
      ? events.getSymposiumArtifactAdmission(context.sessionId, ref.transitionId)
      : null;
  const seal = events.getSymposiumArtifactSealByFence(fenceId);
  if (
    config.version !== 2 ||
    config.state !== 'active' ||
    !member ||
    member.state !== 'active' ||
    member.reconciliation !== 'confirmed' ||
    member.generation !== membershipGeneration ||
    !ref ||
    'kind' in ref ||
    !record?.receipt ||
    !seal ||
    seal.selection.sessionId !== context.sessionId ||
    seal.selection.artifact.volumeGeneration !== generationId ||
    record.binding.sessionId !== context.sessionId ||
    record.binding.seatId !== seatId ||
    record.binding.successorMembershipGeneration !== membershipGeneration ||
    record.binding.childGenerationId !== generationId ||
    record.binding.resultingConfigRevision > config.revision ||
    artifactAdmissionDigest(record.reference) !== artifactAdmissionDigest(ref) ||
    record.receipt.bindingDigest !== artifactAdmissionDigest(record.binding) ||
    record.receipt.pointerRevision !== ref.pointerRevision
  )
    throw new Error('Exact sealed coder pointer required');
  events.withSymposiumHistoricalArtifactSealSnapshot(seal, () => {});
  return ref;
}

/** A sealed writer remains the current result while a proven reader transition
 * advances the config revision. Derive its generation from that result's exact
 * seal intent and validate the historical writer pointer under the event fence. */
export function historicalSealedResultCoderGeneration(
  events: Parameters<typeof historicalFixPointer>[0],
  context: ReviewContext,
  result: { evidenceRefs: string[] } | null,
): string | null {
  if (!result) return null;
  if (result.evidenceRefs.length !== 1 || !result.evidenceRefs[0].startsWith('artifact-seal:'))
    throw new Error('Exact sealed coder result required');
  const fenceId = result.evidenceRefs[0].slice('artifact-seal:'.length);
  const seal = fenceId && events.getSymposiumArtifactSealByFence(fenceId);
  const config = events.getActiveSymposiumConfig(context.sessionId);
  const coders = config.seats.filter((seat) => seat.role === 'coder');
  if (
    !seal ||
    config.version !== 2 ||
    config.state !== 'active' ||
    coders.length !== 1 ||
    seal.selection.sessionId !== context.sessionId
  )
    throw new Error('Exact sealed coder result required');
  const members = seal.memberships.filter((member) => member.seatId === coders[0].id);
  if (members.length !== 1) throw new Error('Exact sealed coder membership required');
  const generationId = seal.selection.artifact.volumeGeneration;
  historicalFixPointer(events, context, coders[0].id, members[0].generation, generationId, fenceId);
  return generationId;
}

/** Trusted parent-only composition. All missing physical dependencies fail closed
 * before any review route becomes available. No request can provide a callback. */
export function createSymposiumProductionReviewComposition(deps: {
  host: PhysicalHost;
  events: EventStore;
  reviews: SymposiumReviewStore;
  grants: SymposiumHostGrants;
  actionAuthority: SymposiumReviewActionAuthority;
  artifactResultsPath: string;
  runtime(sessionId: string): SymposiumOrchestrator | null;
  retainedRuntime(
    sessionId: string,
  ): { orchestrator: SymposiumOrchestrator; runtime: object } | null;
}) {
  const { host, events, reviews, grants } = deps;
  const source = host.sourceImport;
  if (
    !source?.requireSeal ||
    !source.initialExport ||
    !host.gateway ||
    !host.sealSessionArtifacts ||
    !host.requireCompletedArtifactSeal ||
    !host.inspectCompletedArtifact ||
    !host.exportCompletedReviewContext ||
    !host.exportSuccessorArtifactBundle ||
    !host.copySuccessorArtifact ||
    !host.admitSuccessorArtifact ||
    !host.inspectStoppedSuccessorOperation ||
    !host.assertArtifactAdmissionCurrent ||
    !host.artifactLeaseHost ||
    !host.attemptRegistry
  )
    throw new Error('Complete trusted physical review host required');
  const runtime = (context: ReviewContext) => {
    const selected = deps.runtime(context.sessionId);
    if (!selected) throw new Error('Retained trusted review runtime unavailable');
    return selected;
  };
  const sourceIdentity = (context: ReviewContext): Identity => {
    const sealed = source.requireSeal!(context.sessionId);
    if (sealed.receipt.sessionId !== context.sessionId)
      throw new Error('Imported source session changed');
    return { revision: sealed.receipt.git.commit, hash: sealed.receipt.git.committedTreeDigest };
  };
  const currentCoderGeneration = (sessionId: string): string | null => {
    const config = events.getActiveSymposiumConfig(sessionId);
    const coders = config.seats.filter((seat) => seat.role === 'coder');
    if (coders.length !== 1) return null;
    const membership = events.getLatestSymposiumMembership(sessionId, coders[0].id);
    if (!membership) return null;
    const ref = events.getSymposiumArtifactReference(
      sessionId,
      coders[0].id,
      membership.generation,
    );
    if (!ref || 'kind' in ref) return null;
    events.assertSymposiumArtifactAdmissionCurrent(sessionId, ref);
    return ref.artifactGenerationId;
  };
  const artifacts = createOwnedReviewArtifactResults(deps.artifactResultsPath, {
    async sealCompleted(context, completion) {
      const retained = deps.retainedRuntime(context.sessionId);
      if (!retained || retained.orchestrator !== runtime(context))
        throw new Error('Exact retained native runtime required for artifact seal');
      const seal = await host.sealSessionArtifacts!(
        {
          sessionId: context.sessionId,
          expectedConfigRevision: completion.attempt.binding.configRevision,
          idempotencyKey: `review-seal-${createHash('sha256').update(completion.attempt.attemptId).digest('hex')}`,
          repositoryPath: '.',
        },
        retained.runtime,
        AbortSignal.timeout(600_000),
      );
      return {
        seal,
        claimToken: completion.attempt.binding.claimToken,
        operationId: canonicalReviewJson({
          thread: completion.observation.identity.providerThreadId,
          turn: completion.observation.identity.providerTurnId,
        }),
      };
    },
    sealByFence: (fenceId) =>
      host.requireCompletedArtifactSeal!(fenceId, AbortSignal.timeout(120_000)),
    sealIntent: (fenceId) => events.getSymposiumArtifactSealByFence(fenceId),
    volumeGeneration: currentCoderGeneration,
  });
  const checks =
    host.checkCompletedArtifactFile && host.criterionChecks?.length
      ? createOwnedCriterionReceipts(deps.artifactResultsPath, {
          definitions: host.criterionChecks,
          currentGeneration: (context) =>
            historicalSealedResultCoderGeneration(
              events,
              context,
              artifacts.currentResult(context),
            ),
          currentResult(context) {
            const state = reviews.applicationWorkflowForSession(context.sessionId);
            const result = artifacts.currentResult(context);
            return state?.owner === context.owner &&
              result?.resultId === state.currentResultId &&
              result.artifactRevision === state.artifactRevision &&
              result.artifactHash === state.artifactHash
              ? result
              : null;
          },
          async requireSeal(fenceId) {
            const seal = await host.requireCompletedArtifactSeal!(
              fenceId,
              AbortSignal.timeout(120_000),
            );
            const intent = events.getSymposiumArtifactSealByFence(fenceId);
            if (!intent || intent.selection.sessionId !== seal.sessionId)
              throw new Error('Criterion artifact generation unavailable');
            return {
              seal,
              digest: createHash('sha256').update(canonicalReviewJson(seal)).digest('hex'),
              generationId: intent.selection.artifact.volumeGeneration,
            };
          },
          async execute(context, result, definition, definitionDigest) {
            const receipt = await host.checkCompletedArtifactFile!(
              {
                fenceId: result.evidenceRefs[0].slice('artifact-seal:'.length),
                operationId: `criterion-${createHash('sha256')
                  .update(
                    canonicalReviewJson({ context, resultId: result.resultId, definitionDigest }),
                  )
                  .digest('hex')}`,
                path: definition.path,
              },
              AbortSignal.timeout(120_000),
            );
            return { ...receipt, definitionDigest };
          },
        })
      : null;
  try {
    const currentArtifact = (context: ReviewContext) =>
      artifacts.currentOrNull(context) ?? sourceIdentity(context);
    const currentFence = (context: ReviewContext, artifact: Identity) =>
      artifacts.currentFence(context, artifact);
    const completedSeal = (fenceId: string) =>
      host.requireCompletedArtifactSeal!(fenceId, AbortSignal.timeout(120_000));
    const reader = createSealedReaderReviewTransition({
      events,
      reviews,
      leaseHost: host.artifactLeaseHost,
      sourceFence: currentFence,
      requireCompletedSeal: completedSeal,
      baseBranch(context) {
        const sealed = source.requireSeal!(context.sessionId);
        if (sealed.receipt.sessionId !== context.sessionId)
          throw new Error('Imported source session changed');
        return sealed.exported.receipt.selection.defaultBranch;
      },
      exportReviewContext: (input) =>
        host.exportCompletedReviewContext!(input, AbortSignal.timeout(120_000)),
      retainReviewPages: (input) => reviews.retainReviewPages(input),
      markReviewPromptPageDelivered: (input) => reviews.markReviewPromptPageDelivered(input),
      currentArtifact,
      verifyReviewer(context, seat, membershipGeneration) {
        grants.verifySeat({ sessionId: context.sessionId, seat, membershipGeneration });
        return true;
      },
      runtime,
    });
    const initial = createSealedInitialReviewTransition({
      events,
      assertConfirmed: (sessionId, reference) =>
        host.assertArtifactAdmissionCurrent!(sessionId, reference),
      reviews,
      grants,
      workspace: host.gateway.workspace,
      source: {
        requireSeal: (sessionId) => source.requireSeal!(sessionId),
        initialExport: (sessionId, operationId) => source.initialExport!(sessionId, operationId),
      },
      copy: (request, receipt, bundle, signal) =>
        host.copySuccessorArtifact!(request, receipt, bundle, signal),
      admit: (request, binding, receipt, bundle, signal) =>
        host.admitSuccessorArtifact!(request, binding, receipt, bundle, signal),
      runtime,
    });
    const fix = createSealedFixReviewTransition({
      events,
      assertConfirmed: (sessionId, reference) =>
        host.assertArtifactAdmissionCurrent!(sessionId, reference),
      reviews,
      grants,
      workspace: host.gateway.workspace,
      currentArtifact,
      sourceFence: currentFence,
      requireCompletedSeal: completedSeal,
      baseBranch(context) {
        const sealed = source.requireSeal!(context.sessionId);
        if (sealed.receipt.sessionId !== context.sessionId)
          throw new Error('Imported source session changed');
        return sealed.exported.receipt.selection.defaultBranch;
      },
      inspect: async (input, signal) => {
        const inspected = await host.inspectCompletedArtifact!(input, signal);
        if (!inspected.sourceBranch || !inspected.sourceOid)
          throw new Error('Sealed fix source branch unavailable');
        return { sourceBranch: inspected.sourceBranch, sourceOid: inspected.sourceOid };
      },
      exportSuccessor: (input, signal) => host.exportSuccessorArtifactBundle!(input, signal),
      currentPointer(context, seatId, membershipGeneration) {
        const artifact = currentArtifact(context);
        const fenceId = currentFence(context, artifact);
        const seal = events.getSymposiumArtifactSealByFence(fenceId);
        if (!seal) throw new Error('Current sealed fix parent unavailable');
        return historicalFixPointer(
          events,
          context,
          seatId,
          membershipGeneration,
          seal.selection.artifact.volumeGeneration,
          fenceId,
        );
      },
      copy: (request, receipt, bundle, signal) =>
        host.copySuccessorArtifact!(request, receipt, bundle, signal),
      admit: (request, binding, receipt, bundle, signal) =>
        host.admitSuccessorArtifact!(request, binding, receipt, bundle, signal),
      runtime,
    });
    const reviewHost = createSymposiumTrustedReviewHost({
      events,
      reviews,
      requireReviewPageCoverage: true,
      registry: host.attemptRegistry,
      runtime,
      profiles: host.currentProfiles,
      grants,
      selectedSeats(context) {
        const config = events.getActiveSymposiumConfig(context.sessionId);
        const coders = config.seats.filter((seat) => seat.role === 'coder');
        const reviewers = config.seats.filter((seat) => seat.role === 'reviewer');
        if (coders.length !== 1 || reviewers.length !== 1 || coders[0].id === reviewers[0].id)
          throw new Error('Exactly one coder and independent reviewer required');
        return { implementerSeatId: coders[0].id, reviewerSeatId: reviewers[0].id };
      },
      transition: {
        prepare: (input) =>
          input.kind === 'initial'
            ? initial.prepare(input)
            : input.kind === 'fix'
              ? fix.prepare(input)
              : reader.transition.prepare(input),
        apply: (context, prep) =>
          prep.kind === 'initial'
            ? initial.apply(context, prep)
            : prep.kind === 'fix'
              ? fix.apply(context, prep)
              : reader.transition.apply(context, prep),
        reconcileStopped: (context, preparation) =>
          reconcileStoppedApplicationPreparation(
            {
              reviews,
              events,
              successorState: async (selected, sessionId) =>
                selected.kind === 'initial' || selected.kind === 'fix'
                  ? host.inspectStoppedSuccessorOperation!({
                      sessionId,
                      transitionId: selected.transitionId,
                      workflowId: selected.workflowId,
                      attemptId: selected.attemptId,
                      kind: selected.kind,
                    })
                  : null,
              cancelDelivery: (deliveryId, idempotencyKey, applicationControl) =>
                runtime(context).cancel({
                  deliveryId,
                  idempotencyKey,
                  reason: 'Application review preparation stopped',
                  applicationControl,
                }),
            },
            context,
            preparation,
          ),
      },
      artifacts: {
        current: currentArtifact,
        initial: sourceIdentity,
        refresh: artifacts.refresh,
        result: artifacts.result,
        evidence: (context, id) => checks?.evidence(context, id) ?? null,
      },
      runCriterionCheck: checks
        ? async (context, workflowId, definitionId) => {
            const state = reviews.get(workflowId);
            const definition = host.criterionChecks!.find((item) => item.id === definitionId);
            if (
              !state ||
              state.owner !== context.owner ||
              state.sessionId !== context.sessionId ||
              !definition ||
              !state.acceptanceCriteria.includes(definition.criterion)
            )
              throw new Error('Registered acceptance criterion unavailable');
            const evidence = await checks.run(context, definitionId);
            return { evidenceId: evidence.evidenceId };
          }
        : undefined,
      criterionChecks: () =>
        checks
          ? host.criterionChecks!.map(({ id, criterion, kind, path }) => ({
              id,
              criterion,
              kind,
              path,
            }))
          : [],
      authorizeAction: (context, action) => deps.actionAuthority.authorize(context, action.kind),
    });
    return {
      reviewHost,
      assertReaderAdmissionCurrent: reader.assertReaderAdmissionCurrent,
      close: () => {
        checks?.close();
        artifacts.close();
      },
    };
  } catch (error) {
    checks?.close();
    artifacts.close();
    throw error;
  }
}
