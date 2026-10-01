import { createHash } from 'node:crypto';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import type { ArtifactAdmissionReferenceV1 } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SymposiumProductionHost } from './app.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
import type { SymposiumHostGrants } from './symposium-host-grants.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
import type { SymposiumReviewActionAuthority } from './symposium-review-action-authority.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import { createOwnedReviewArtifactResults } from './symposium-owned-review-artifacts.js';
import {
  SemanticCriterionDefinitionSchema,
  createOwnedCriterionReceipts,
} from './symposium-criterion-receipts.js';
import { createSealedInitialReviewTransition } from './symposium-trusted-initial-transition.js';
import { createSealedFixReviewTransition } from './symposium-trusted-fix-transition.js';
import { createSealedReaderReviewTransition } from './symposium-trusted-reader-transition.js';
import {
  type TrustedReviewCompletion,
  createSymposiumTrustedReviewHost,
} from './symposium-trusted-review-host.js';
import { canonicalReviewJson } from './symposium-review-records.js';
import {
  drainSymposiumRuntimeForArtifactSeal,
  isSymposiumRuntimeDrainedForSeal,
  isSymposiumRuntimeSealingForFence,
  isSymposiumRuntimeUnrelatedToClaim,
} from './symposium-session-runtime.js';
import { reconcileStoppedApplicationPreparation } from './symposium-stopped-preparation.js';

type PhysicalHost = SymposiumProductionHost;
type Identity = { revision: string; hash: string };

/** Stable original operation identity shared by execution and cleanup. */
export function criterionOperationId(
  context: ReviewContext,
  resultId: string,
  definitionDigest: string,
): string {
  return `criterion-${createHash('sha256').update(canonicalReviewJson({ context, resultId, definitionDigest })).digest('hex')}`;
}

/** Request-owned cleanup controller: never executes a criterion or creates a helper. */
export async function runOriginalCriterionCleanup(
  select: () => Parameters<NonNullable<PhysicalHost['reconcileCompletedArtifactSemantic']>>[0],
  reconcile: NonNullable<PhysicalHost['reconcileCompletedArtifactSemantic']>,
) {
  const input = select();
  const controller = new AbortController();
  const expiry = setTimeout(() => controller.abort(), 120_000);
  const current = setInterval(() => {
    try {
      if (canonicalReviewJson(select()) !== canonicalReviewJson(input)) controller.abort();
    } catch {
      controller.abort();
    }
  }, 25);
  try {
    const receipt = await reconcile(input, controller.signal);
    controller.signal.throwIfAborted();
    if (canonicalReviewJson(select()) !== canonicalReviewJson(input))
      throw new Error('Original semantic cleanup binding changed');
    return { ...receipt, retryAllowed: false as const, semanticEvidenceAllowed: false as const };
  } finally {
    clearTimeout(expiry);
    clearInterval(current);
  }
}

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

/** A completed physical seal drains its retained runtime. Remove that exact
 * runtime only after the seal succeeds so the next seat gets a fresh owner. */
export async function sealWithRetiredReviewRuntime<T>(input: {
  current: object;
  retained: { orchestrator: object; runtime: object } | null;
  seal(runtime: object): Promise<T>;
  retire(runtime: object): void;
}): Promise<T> {
  if (!input.retained || input.retained.orchestrator !== input.current)
    throw new Error('Exact retained native runtime required for artifact seal');
  const sealed = await input.seal(input.retained.runtime);
  input.retire(input.retained.runtime);
  return sealed;
}

/** A terminal observation cannot retire a runtime while another claim's
 * durable preparation or controller journal still needs reconciliation. */
export function assertCompletedReaderClaimsSettled(
  registry: Pick<SymposiumAttemptRegistry, 'pending' | 'pendingPreparations'>,
  sessionId: string,
): void {
  if (
    registry.pending().some((claim) => claim.sessionId === sessionId) ||
    registry.pendingPreparations().some((claim) => claim.sessionId === sessionId)
  )
    throw new Error('Completed reader runtime still has unresolved work');
}

/** Read-only proof of an already cleaned historical reader. A review record is
 * insufficient: keep exact physical owner rows, lease admission and lineage bound. */
export function hasCompletedReaderCleanupProof(input: {
  context: ReviewContext;
  completion: TrustedReviewCompletion;
  events: Pick<
    EventStore,
    | 'getActiveSymposiumConfig'
    | 'getSymposiumSeatSandbox'
    | 'getSymposiumSealedReaderAdmission'
    | 'getSymposiumArtifactSealByFence'
    | 'getSymposiumMembershipHistory'
    | 'withSymposiumHistoricalArtifactSealSnapshot'
  >;
  registry: Pick<SymposiumAttemptRegistry, 'pending' | 'pendingPreparations'>;
  sourceResult: {
    artifactRevision: string;
    artifactHash: string;
    evidenceRefs: string[];
    sealDigest: string;
  } | null;
  currentFence: string;
  retainedUnrelated(): boolean;
}): boolean {
  try {
    const { context, completion, events } = input;
    const { attempt, execution, observation } = completion;
    const provenance = execution.provenance;
    if (
      !provenance ||
      !('version' in provenance) ||
      provenance.version !== 3 ||
      !('kind' in provenance.artifact) ||
      provenance.artifact.kind !== 'sealed_reader' ||
      observation.status !== 'completed' ||
      observation.terminalConflict ||
      observation.terminalAt === null
    )
      return false;
    const reference = provenance.artifact;
    const admission = events.getSymposiumSealedReaderAdmission(
      context.sessionId,
      reference.readerAdmissionId,
    );
    const row = events.getSymposiumSeatSandbox(
      context.sessionId,
      attempt.actorSeatId,
      attempt.binding.membershipGeneration,
    );
    const originalSeal = events.getSymposiumArtifactSealByFence(reference.sealFenceId);
    const currentSeal = events.getSymposiumArtifactSealByFence(input.currentFence);
    const member = events
      .getSymposiumMembershipHistory(context.sessionId)
      .find(
        (value) =>
          value.seatId === attempt.actorSeatId &&
          value.generation === attempt.binding.membershipGeneration,
      );
    if (
      !admission?.receipt ||
      canonicalReviewJson(admission.reference) !== canonicalReviewJson(reference) ||
      admission.receipt.bindingDigest !== artifactAdmissionDigest(admission.binding) ||
      admission.binding.sessionId !== context.sessionId ||
      admission.binding.workflowId !== attempt.workflowId ||
      admission.binding.reviewAttemptId !== attempt.attemptId ||
      admission.binding.policyReservationId !== attempt.policyReservationId ||
      admission.binding.seatId !== attempt.actorSeatId ||
      admission.binding.readerMembershipGeneration !== attempt.binding.membershipGeneration ||
      admission.binding.resultingConfigRevision !== attempt.binding.configRevision ||
      admission.binding.sealFenceId !== reference.sealFenceId ||
      admission.binding.artifactGenerationId !== reference.artifactGenerationId ||
      !row ||
      row.state !== 'stopped' ||
      !row.creationCompleted ||
      !row.physicalId ||
      !row.sandboxName ||
      canonicalReviewJson(row.artifact) !== canonicalReviewJson(reference) ||
      !member ||
      member.action !== 'sealed_reader' ||
      member.state !== 'active' ||
      member.reconciliation !== 'confirmed' ||
      member.configRevision !== attempt.binding.configRevision ||
      !originalSeal ||
      originalSeal.selection.sessionId !== context.sessionId ||
      originalSeal.selection.artifact.volumeGeneration !== reference.artifactGenerationId ||
      !currentSeal ||
      currentSeal.selection.sessionId !== context.sessionId ||
      !input.sourceResult ||
      !/^[a-f0-9]{64}$/.test(input.sourceResult.sealDigest) ||
      admission.binding.sealDigest !==
        createHash('sha256').update(JSON.stringify(originalSeal)).digest('hex') ||
      input.sourceResult.artifactRevision !== attempt.artifactRevision ||
      input.sourceResult.artifactHash !== attempt.artifactHash ||
      canonicalReviewJson(input.sourceResult.evidenceRefs) !==
        canonicalReviewJson([`artifact-seal:${reference.sealFenceId}`]) ||
      !input.retainedUnrelated()
    )
      return false;
    const config = events.getActiveSymposiumConfig(context.sessionId);
    if (
      createHash('sha256')
        .update(
          JSON.stringify({ ...config, revision: originalSeal.selection.expectedConfigRevision }),
        )
        .digest('hex') !== originalSeal.configDigest
    )
      return false;
    if (currentSeal.fenceId !== originalSeal.fenceId) {
      const capturedMember = currentSeal.memberships.find(
        (value) => value.seatId === member.seatId && value.generation === member.generation,
      );
      if (
        !capturedMember ||
        capturedMember.state !== member.state ||
        capturedMember.reconciliation !== member.reconciliation ||
        capturedMember.bindingDigest !==
          createHash('sha256').update(JSON.stringify(member.bindingKey)).digest('hex')
      )
        return false;
    }
    const pending = [...input.registry.pending(), ...input.registry.pendingPreparations()];
    if (
      pending.some(
        (claim) =>
          claim.sessionId === context.sessionId &&
          (claim.claimToken === attempt.binding.claimToken ||
            !claim.artifact ||
            canonicalReviewJson(claim.artifact) === canonicalReviewJson(reference)),
      )
    )
      return false;
    let proven = false;
    events.withSymposiumHistoricalArtifactSealSnapshot(currentSeal, () => {
      proven = true;
    });
    return proven;
  } catch {
    return false;
  }
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
  retireSealedRuntime(sessionId: string, runtime: object): void;
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
    !host.releaseCompletedReviewStream ||
    !host.releaseReadyReviewStream ||
    !host.releaseStoppedReadyReviewStream ||
    !host.trackApplicationTransition ||
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
      const idempotencyKey = `review-seal-${createHash('sha256').update(completion.attempt.attemptId).digest('hex')}`;
      const provenance = completion.observation.identity.provenance;
      const generation =
        'version' in provenance && provenance.version === 3
          ? provenance.artifact.artifactGenerationId
          : null;
      const intent = generation
        ? events.getSymposiumArtifactSealIntent(context.sessionId, generation)
        : null;
      const retained = deps.retainedRuntime(context.sessionId);
      // A response may be lost after the physical seal has retired its writer.
      // Reconcile that exact attempt's retained seal before asking for a runtime;
      // allocating a new runtime cannot restore the old writer's authority.
      if (intent) {
        if (
          intent.selection.sessionId !== context.sessionId ||
          intent.selection.artifact.volumeGeneration !== generation ||
          intent.selection.idempotencyKey !== idempotencyKey ||
          intent.selection.expectedConfigRevision !== completion.attempt.binding.configRevision
        )
          throw new Error('Retained review artifact seal identity changed');
        if (
          retained &&
          isSymposiumRuntimeSealingForFence(
            retained.runtime,
            events,
            host.artifactLeaseHost,
            context.sessionId,
            intent.fenceId,
          )
        ) {
          const seal = await sealWithRetiredReviewRuntime({
            current: runtime(context),
            retained,
            seal: (selected) =>
              host.sealSessionArtifacts!(
                {
                  sessionId: context.sessionId,
                  expectedConfigRevision: completion.attempt.binding.configRevision,
                  idempotencyKey,
                  repositoryPath: '.',
                },
                selected,
                AbortSignal.timeout(600_000),
              ),
            retire: (selected) => deps.retireSealedRuntime(context.sessionId, selected),
          });
          return {
            seal,
            claimToken: completion.attempt.binding.claimToken,
            operationId: canonicalReviewJson({
              thread: completion.observation.identity.providerThreadId,
              turn: completion.observation.identity.providerTurnId,
            }),
          };
        }
        const seal =
          !retained && host.recoverPendingArtifactSeal
            ? await host.recoverPendingArtifactSeal(
                {
                  sessionId: context.sessionId,
                  expectedConfigRevision: completion.attempt.binding.configRevision,
                  idempotencyKey,
                  repositoryPath: '.',
                },
                completion.attempt.binding.claimToken,
                AbortSignal.timeout(600_000),
              )
            : await host.requireCompletedArtifactSeal!(
                intent.fenceId,
                AbortSignal.timeout(120_000),
              );
        if (
          retained &&
          isSymposiumRuntimeDrainedForSeal(
            retained.runtime,
            events,
            host.artifactLeaseHost,
            context.sessionId,
            intent.fenceId,
          )
        )
          deps.retireSealedRuntime(context.sessionId, retained.runtime);
        return {
          seal,
          claimToken: completion.attempt.binding.claimToken,
          operationId: canonicalReviewJson({
            thread: completion.observation.identity.providerThreadId,
            turn: completion.observation.identity.providerTurnId,
          }),
        };
      }
      const seal = await sealWithRetiredReviewRuntime({
        current: runtime(context),
        retained,
        seal: (selected) =>
          host.sealSessionArtifacts!(
            {
              sessionId: context.sessionId,
              expectedConfigRevision: completion.attempt.binding.configRevision,
              idempotencyKey,
              repositoryPath: '.',
            },
            selected,
            AbortSignal.timeout(600_000),
          ),
        retire: (selected) => deps.retireSealedRuntime(context.sessionId, selected),
      });
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
    host.criterionChecks?.length &&
    host.criterionChecks.every((definition) =>
      definition.kind === 'file-sha256'
        ? !!host.checkCompletedArtifactFile
        : !!host.checkCompletedArtifactSemantic,
    )
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
            const operationId = criterionOperationId(context, result.resultId, definitionDigest);
            const selected = {
              fenceId: result.evidenceRefs[0].slice('artifact-seal:'.length),
              operationId,
            };
            const receipt =
              definition.kind === 'file-sha256'
                ? await host.checkCompletedArtifactFile!(
                    { ...selected, path: definition.path },
                    AbortSignal.timeout(120_000),
                  )
                : await host.checkCompletedArtifactSemantic!(
                    { ...selected, definition },
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
      assertRetainedReviewPagesComplete: (input) =>
        reviews.assertRetainedReviewPagesComplete(input),
      releaseCompletedReviewStream: (input) => host.releaseCompletedReviewStream!(input),
      releaseReadyReviewStream: (input) => host.releaseReadyReviewStream!(input),
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
      readerCleanupComplete(context, completion) {
        try {
          const workflow = reviews.get(completion.attempt.workflowId);
          const provenance = completion.execution.provenance;
          if (
            workflow?.owner !== context.owner ||
            workflow.sessionId !== context.sessionId ||
            !provenance ||
            !('version' in provenance) ||
            provenance.version !== 3 ||
            !('kind' in provenance.artifact) ||
            provenance.artifact.kind !== 'sealed_reader'
          )
            return false;
          const sourceResult = artifacts.completedSourceResult(context, {
            workflowId: completion.attempt.workflowId,
            artifactRevision: completion.attempt.artifactRevision,
            artifactHash: completion.attempt.artifactHash,
            fenceId: provenance.artifact.sealFenceId,
          });
          const retained = deps.retainedRuntime(context.sessionId);
          return hasCompletedReaderCleanupProof({
            context,
            completion,
            events,
            registry: host.attemptRegistry!,
            sourceResult,
            currentFence: currentFence(context, currentArtifact(context)),
            retainedUnrelated: () =>
              !retained ||
              isSymposiumRuntimeUnrelatedToClaim(
                retained.runtime,
                events,
                host.artifactLeaseHost,
                context.sessionId,
                completion.attempt.binding.claimToken,
              ),
          });
        } catch {
          return false;
        }
      },
      async retireCompletedReader(context, completion) {
        const provenance = completion.execution.provenance;
        if (
          !provenance ||
          !('version' in provenance) ||
          provenance.version !== 3 ||
          !('kind' in provenance.artifact) ||
          provenance.artifact.kind !== 'sealed_reader'
        )
          throw new Error('Exact completed reader artifact required');
        const reference = provenance.artifact;
        reader.assertReaderAdmissionCurrent(
          events.assertSymposiumSealedReaderAdmissionCurrent(context.sessionId, reference),
        );
        assertCompletedReaderClaimsSettled(host.attemptRegistry!, context.sessionId);
        if (reference.sealFenceId !== currentFence(context, currentArtifact(context)))
          throw new Error('Completed reader runtime still has unresolved work');
        const retained = deps.retainedRuntime(context.sessionId);
        if (!retained) {
          if (
            events
              .listSymposiumSessionSandboxes(context.sessionId)
              .some((row) => row.state !== 'stopped')
          )
            throw new Error('Exact retained completed reader runtime required');
          return;
        }
        if (
          retained.orchestrator !== runtime(context) ||
          events
            .listSymposiumSessionSandboxes(context.sessionId)
            .some(
              (row) =>
                row.state !== 'stopped' &&
                (row.seatId !== completion.attempt.actorSeatId ||
                  row.generation !== completion.attempt.binding.membershipGeneration ||
                  canonicalReviewJson(row.artifact) !== canonicalReviewJson(reference)),
            )
        )
          throw new Error('Exact retained completed reader runtime required');
        await drainSymposiumRuntimeForArtifactSeal(
          retained.runtime,
          events,
          host.artifactLeaseHost,
          context.sessionId,
          AbortSignal.timeout(120_000),
        );
        assertCompletedReaderClaimsSettled(host.attemptRegistry!, context.sessionId);
        reader.assertReaderAdmissionCurrent(
          events.assertSymposiumSealedReaderAdmissionCurrent(context.sessionId, reference),
        );
        if (
          deps.retainedRuntime(context.sessionId)?.runtime !== retained.runtime ||
          reference.sealFenceId !== currentFence(context, currentArtifact(context)) ||
          events
            .listSymposiumSessionSandboxes(context.sessionId)
            .some((row) => row.state !== 'stopped')
        )
          throw new Error('Completed reader cleanup remains uncertain');
        deps.retireSealedRuntime(context.sessionId, retained.runtime);
      },
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
          host.trackApplicationTransition!(() =>
            prep.kind === 'initial'
              ? initial.apply(context, prep)
              : prep.kind === 'fix'
                ? fix.apply(context, prep)
                : reader.transition.apply(context, prep),
          ),
        reconcileStopped: (context, preparation) =>
          host.trackApplicationTransition!(() =>
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
                releaseStoppedReviewStream: async (selected, sessionId) => {
                  const sealed = source.requireSeal!(sessionId);
                  if (sealed.receipt.sessionId !== sessionId)
                    throw new Error('Imported source session changed');
                  const operationId = `context-${createHash('sha256')
                    .update(`${selected.workflowId}:${selected.attemptId}:${selected.seal.fenceId}`)
                    .digest('hex')}`;
                  await host.releaseStoppedReadyReviewStream!({
                    fenceId: selected.seal.fenceId,
                    operationId,
                    baseBranch: sealed.exported.receipt.selection.defaultBranch,
                  });
                },
              },
              context,
              preparation,
            ),
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
      cleanupCriterionCheck:
        host.reconcileCompletedArtifactSemantic && host.criterionChecks
          ? async (context, workflowId, definitionId) => {
              const selected = () => {
                deps.actionAuthority.assertCurrent(context, 'cleanup-check');
                const state = reviews.get(workflowId);
                const current = artifacts.currentResult(context);
                const rawDefinition = host.criterionChecks!.find(
                  (item) => item.id === definitionId,
                );
                if (
                  !state ||
                  state.owner !== context.owner ||
                  state.sessionId !== context.sessionId ||
                  !rawDefinition ||
                  rawDefinition.kind !== 'python-json-cases' ||
                  !state.acceptanceCriteria.includes(rawDefinition.criterion) ||
                  !current ||
                  current.resultId !== state.currentResultId ||
                  current.artifactRevision !== state.artifactRevision ||
                  current.artifactHash !== state.artifactHash ||
                  current.evidenceRefs.length !== 1 ||
                  !current.evidenceRefs[0].startsWith('artifact-seal:')
                )
                  throw new Error('Original registered semantic cleanup binding unavailable');
                const fenceId = current.evidenceRefs[0].slice('artifact-seal:'.length);
                const owned = artifacts.completedSourceResult(context, {
                  workflowId,
                  fenceId,
                  artifactRevision: current.artifactRevision,
                  artifactHash: current.artifactHash,
                });
                if (
                  !owned ||
                  owned.resultId !== current.resultId ||
                  owned.attemptId !== current.attemptId ||
                  owned.artifactRevision !== current.artifactRevision ||
                  owned.artifactHash !== current.artifactHash
                )
                  throw new Error('Original owned semantic result unavailable');
                const generation = historicalSealedResultCoderGeneration(events, context, current);
                if (!generation) throw new Error('Original semantic generation unavailable');
                const definition = SemanticCriterionDefinitionSchema.parse(rawDefinition);
                const definitionDigest = createHash('sha256')
                  .update(canonicalReviewJson(definition))
                  .digest('hex');
                return {
                  fenceId,
                  operationId: criterionOperationId(context, current.resultId, definitionDigest),
                  definition,
                };
              };
              return runOriginalCriterionCleanup(selected, (input, signal) =>
                host.reconcileCompletedArtifactSemantic!(input, signal, () => {
                  if (canonicalReviewJson(selected()) !== canonicalReviewJson(input))
                    throw new Error('Original semantic cleanup binding changed');
                }),
              );
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
      assertReaderAdmissionStaged: reader.assertReaderAdmissionStaged,
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
