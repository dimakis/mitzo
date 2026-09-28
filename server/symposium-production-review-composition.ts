import { createHash } from 'node:crypto';
import type { EventStore } from './event-store.js';
import type { SymposiumProductionHost } from './app.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
import type { SymposiumHostGrants } from './symposium-host-grants.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
import type { SymposiumReviewActionAuthority } from './symposium-review-action-authority.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import { createOwnedReviewArtifactResults } from './symposium-owned-review-artifacts.js';
import { createSealedInitialReviewTransition } from './symposium-trusted-initial-transition.js';
import { createSealedFixReviewTransition } from './symposium-trusted-fix-transition.js';
import { createSealedReaderReviewTransition } from './symposium-trusted-reader-transition.js';
import { createSymposiumTrustedReviewHost } from './symposium-trusted-review-host.js';
import { canonicalReviewJson } from './symposium-review-records.js';

type PhysicalHost = SymposiumProductionHost;
type Identity = { revision: string; hash: string };

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
    !host.exportSuccessorArtifactBundle ||
    !host.copySuccessorArtifact ||
    !host.activateSuccessorArtifact ||
    !host.admitSuccessorArtifact ||
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
    volumeGeneration(sessionId) {
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
    },
  });
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
      currentArtifact,
      verifyReviewer(context, seat, membershipGeneration) {
        grants.verifySeat({ sessionId: context.sessionId, seat, membershipGeneration });
        return true;
      },
      runtime,
    });
    const initial = createSealedInitialReviewTransition({
      events,
      reviews,
      grants,
      workspace: host.gateway.workspace,
      source: {
        requireSeal: (sessionId) => source.requireSeal!(sessionId),
        initialExport: (sessionId, operationId) => source.initialExport!(sessionId, operationId),
      },
      copy: (request, receipt, bundle, signal) =>
        host.copySuccessorArtifact!(request, receipt, bundle, signal),
      activate: (request, generationId, receipt, bundle, signal) =>
        host.activateSuccessorArtifact!(request, generationId, receipt, bundle, signal),
      admit: (request, binding, receipt, bundle, signal) =>
        host.admitSuccessorArtifact!(request, binding, receipt, bundle, signal),
      runtime,
    });
    const fix = createSealedFixReviewTransition({
      events,
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
        const ref = events.getSymposiumArtifactReference(
          context.sessionId,
          seatId,
          membershipGeneration,
        );
        if (!ref || 'kind' in ref) throw new Error('Confirmed current writer generation required');
        events.assertSymposiumArtifactAdmissionCurrent(context.sessionId, ref);
        return ref;
      },
      copy: (request, receipt, bundle, signal) =>
        host.copySuccessorArtifact!(request, receipt, bundle, signal),
      activate: (request, generationId, receipt, bundle, signal) =>
        host.activateSuccessorArtifact!(request, generationId, receipt, bundle, signal),
      admit: (request, binding, receipt, bundle, signal) =>
        host.admitSuccessorArtifact!(request, binding, receipt, bundle, signal),
      runtime,
    });
    const reviewHost = createSymposiumTrustedReviewHost({
      events,
      reviews,
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
      },
      artifacts: {
        current: currentArtifact,
        initial: sourceIdentity,
        refresh: artifacts.refresh,
        result: artifacts.result,
        evidence: () => null,
      },
      authorizeAction: (context, action) => deps.actionAuthority.authorize(context, action.kind),
    });
    return {
      reviewHost,
      assertReaderAdmissionCurrent: reader.assertReaderAdmissionCurrent,
      close: artifacts.close,
    };
  } catch (error) {
    artifacts.close();
    throw error;
  }
}
