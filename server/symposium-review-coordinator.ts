import type { OutcomeEvidenceSchema, WorkResultSchema } from '@mitzo/protocol';
import type { z } from 'zod';
import { SymposiumReviewStore } from './symposium-review-workflows.js';

type WorkResult = z.infer<typeof WorkResultSchema>;
type OutcomeEvidence = z.infer<typeof OutcomeEvidenceSchema>;
type Workflow = NonNullable<ReturnType<SymposiumReviewStore['get']>>;
type Roles = Parameters<SymposiumReviewStore['createWithPolicies']>[1];
type Limits = Workflow['limits'];
type Selection = Workflow['reviewer'];

export type ReviewContext = { owner: string; sessionId: string };
export type ReviewAttemptKind = 'review' | 'fix';
export type ReviewReceipt = {
  workflowId: string;
  attemptId: string;
  enforcementId: string;
  terminal: true;
  kind: ReviewAttemptKind;
  actorSeatId: string;
  artifactRevision: string;
  artifactHash: string;
  tokens: number;
  costUsd: number | null;
};

export type CompletedReview = Omit<Parameters<SymposiumReviewStore['recordReview']>[0], 'usage'> & {
  attemptId: string;
  enforcementId: string;
};

/** Only a trusted host implementation may supply these facts. It never launches a provider call. */
export interface SymposiumReviewHost {
  completedImplementation(context: ReviewContext): WorkResult;
  currentArtifact(context: ReviewContext): { revision: string; hash: string };
  selectRoles(context: ReviewContext): Roles;
  /** 'enforced' must mean native hard token/price caps, seat authority, and exact artifact
   * are bound to enforcementId. An estimate does not satisfy this contract.
   */
  prepareAttempt(input: {
    context: ReviewContext;
    workflowId: string;
    attemptId: string;
    kind: ReviewAttemptKind;
    selection: Selection;
    artifactRevision: string;
    artifactHash: string;
    remaining: { rounds: number; tokens: number; costUsd: number | null };
  }):
    | { kind: 'enforced'; enforcementId: string; maxTokens: number; maxCostUsd: number | null }
    | { kind: 'decision_required'; code: string };
  /** A receipt exists only after host-observed terminal provider completion and final usage.
   * Planned dispatch or provider acceptance is not completion.
   */
  receipt(context: ReviewContext, attemptId: string): ReviewReceipt | null;
  /** Structured output read from the same completed native attempt as receipt().
   * Never construct this result from an interactive caller's review payload.
   */
  completedReview(context: ReviewContext, attemptId: string): CompletedReview | null;
  /** This must verify a fresh, authenticated user action and current write authority. */
  authorizeFix(input: {
    context: ReviewContext;
    workflowId: string;
    findingFingerprints: string[];
    reason: string;
    artifactRevision: string;
    artifactHash: string;
  }): { actor: string; authorityGrantId: string; authorityRevision: number } | null;
  /** Only the host can attest a new artifact after a fix attempt. */
  fixedArtifact(context: ReviewContext, attemptId: string): WorkResult | null;
  /** Verification evidence must be produced by a host check bound to the current artifact. */
  evidence(context: ReviewContext, evidenceId: string): OutcomeEvidence | null;
}

type CoordinatorDecision = { kind: 'decision_required'; code: string };
const decision = (code: string): CoordinatorDecision => ({ kind: 'decision_required', code });

/** Same-session pre-PR review/fix contract for the existing ChatView's inline actions.
 * Runtime/app wiring supplies the host adapter and authenticated context separately.
 */
export class SymposiumReviewCoordinator {
  constructor(
    private readonly store: SymposiumReviewStore,
    private readonly host: SymposiumReviewHost | null,
  ) {}

  private scoped(context: ReviewContext, workflowId: string): Workflow {
    const state = this.store.get(workflowId);
    if (!state || state.owner !== context.owner || state.sessionId !== context.sessionId)
      throw new Error('Review workflow not found');
    return state;
  }

  private current(context: ReviewContext, state: Workflow): boolean {
    if (!this.host) return false;
    const artifact = this.host.currentArtifact(context);
    return artifact.revision === state.artifactRevision && artifact.hash === state.artifactHash;
  }

  start(
    context: ReviewContext,
    input: { workflowId: string; acceptanceCriteria: string[]; limits: Limits },
  ): Workflow | CoordinatorDecision {
    if (!this.host) return decision('trusted_review_host_unavailable');
    const existing = this.store.get(input.workflowId);
    if (existing) {
      this.scoped(context, input.workflowId);
      if (
        JSON.stringify(existing.acceptanceCriteria) !== JSON.stringify(input.acceptanceCriteria) ||
        JSON.stringify(existing.limits) !== JSON.stringify(input.limits)
      )
        throw new Error('Review workflow idempotency conflict');
      return existing;
    }
    const implementation = this.host.completedImplementation(context);
    const artifact = this.host.currentArtifact(context);
    if (
      implementation.artifactRevision !== artifact.revision ||
      implementation.artifactHash !== artifact.hash
    )
      return decision('artifact_changed');
    return this.store.createWithPolicies(
      {
        workflowId: input.workflowId,
        owner: context.owner,
        sessionId: context.sessionId,
        implementation,
        acceptanceCriteria: input.acceptanceCriteria,
        limits: input.limits,
      },
      this.host.selectRoles(context),
    );
  }

  status(context: ReviewContext, workflowId: string): Workflow {
    return this.scoped(context, workflowId);
  }

  reserve(
    context: ReviewContext,
    workflowId: string,
    kind: ReviewAttemptKind,
    attemptId: string,
  ):
    | CoordinatorDecision
    | {
        kind: 'reserved_not_dispatched';
        attemptId: string;
        enforcementId: string;
        selection: Selection;
        artifactRevision: string;
        artifactHash: string;
      } {
    const state = this.scoped(context, workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    const selection = kind === 'review' ? state.reviewer : state.implementer;
    const prepared = this.host.prepareAttempt({
      context,
      workflowId,
      attemptId,
      kind,
      selection,
      artifactRevision: state.artifactRevision,
      artifactHash: state.artifactHash,
      remaining: {
        rounds: state.limits.maxReviewRounds - state.reviewRounds,
        tokens: state.limits.maxTokens - state.tokensUsed,
        costUsd: state.limits.maxCostUsd === null ? null : state.limits.maxCostUsd - state.costUsd,
      },
    });
    if (prepared.kind !== 'enforced') return decision(prepared.code);
    if (
      !prepared.enforcementId ||
      !Number.isSafeInteger(prepared.maxTokens) ||
      prepared.maxTokens <= 0
    )
      return decision('native_limit_unavailable');
    if (
      state.limits.maxCostUsd !== null &&
      (prepared.maxCostUsd === null || !Number.isFinite(prepared.maxCostUsd))
    )
      return decision('unknown_cost');
    const admission = this.store.admitAttempt({
      workflowId,
      attemptId,
      enforcementId: prepared.enforcementId,
      kind,
      actorSeatId: selection.seatId,
      artifactRevision: state.artifactRevision,
      artifactHash: state.artifactHash,
      maxTokens: prepared.maxTokens,
      maxCostUsd: prepared.maxCostUsd,
    });
    if (admission.kind === 'decision_required') return admission;
    if (admission.kind !== 'admitted') return decision('attempt_already_reserved');
    return {
      kind: 'reserved_not_dispatched',
      attemptId,
      enforcementId: prepared.enforcementId,
      selection,
      artifactRevision: state.artifactRevision,
      artifactHash: state.artifactHash,
    };
  }

  recordReview(
    context: ReviewContext,
    input: { workflowId: string; reviewId: string; attemptId: string },
  ): Workflow | CoordinatorDecision {
    const state = this.scoped(context, input.workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    const receipt = this.host.receipt(context, input.attemptId);
    if (
      !receipt ||
      receipt.terminal !== true ||
      receipt.workflowId !== input.workflowId ||
      receipt.attemptId !== input.attemptId ||
      receipt.enforcementId !==
        state.reservations.find((entry) => entry.attemptId === input.attemptId)?.enforcementId ||
      receipt.kind !== 'review' ||
      receipt.actorSeatId !== state.reviewer.seatId ||
      receipt.artifactRevision !== state.artifactRevision ||
      receipt.artifactHash !== state.artifactHash
    )
      return decision('host_receipt_required');
    const review = this.host.completedReview?.(context, input.attemptId);
    if (
      !review ||
      review.workflowId !== receipt.workflowId ||
      review.attemptId !== receipt.attemptId ||
      review.enforcementId !== receipt.enforcementId ||
      review.reviewerSeatId !== receipt.actorSeatId ||
      review.artifactRevision !== receipt.artifactRevision ||
      review.artifactHash !== receipt.artifactHash ||
      review.reviewId !== input.reviewId
    )
      return decision('host_review_result_required');
    return this.store.recordReview({
      workflowId: review.workflowId,
      reviewId: review.reviewId,
      kind: review.kind,
      findings: review.findings,
      resolvedFingerprints: review.resolvedFingerprints,
      ...(review.failure !== undefined ? { failure: review.failure } : {}),
      reviewerSeatId: receipt.actorSeatId,
      artifactRevision: receipt.artifactRevision,
      artifactHash: receipt.artifactHash,
      usage: { attemptId: receipt.attemptId, tokens: receipt.tokens, costUsd: receipt.costUsd },
    });
  }

  authorizeFix(
    context: ReviewContext,
    input: { workflowId: string; findingFingerprints: string[]; reason: string },
  ): Workflow | CoordinatorDecision {
    const state = this.scoped(context, input.workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    const approval = this.host.authorizeFix({
      context,
      ...input,
      artifactRevision: state.artifactRevision,
      artifactHash: state.artifactHash,
    });
    if (!approval || approval.actor !== context.owner)
      return decision('interactive_fix_authority_required');
    return this.store.authorizeFix({
      ...input,
      ...approval,
      artifactRevision: state.artifactRevision,
      artifactHash: state.artifactHash,
    });
  }

  recordFix(
    context: ReviewContext,
    workflowId: string,
    attemptId: string,
  ): Workflow | CoordinatorDecision {
    const state = this.scoped(context, workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    const receipt = this.host.receipt(context, attemptId);
    const result = this.host.fixedArtifact(context, attemptId);
    const artifact = this.host.currentArtifact(context);
    if (
      !receipt ||
      !result ||
      receipt.terminal !== true ||
      receipt.workflowId !== workflowId ||
      receipt.attemptId !== attemptId ||
      receipt.enforcementId !==
        state.reservations.find((entry) => entry.attemptId === attemptId)?.enforcementId ||
      receipt.kind !== 'fix' ||
      receipt.actorSeatId !== state.implementer.seatId ||
      receipt.artifactRevision !== state.artifactRevision ||
      receipt.artifactHash !== state.artifactHash ||
      result.attemptId !== attemptId ||
      result.inputRevision !== state.artifactRevision ||
      result.inputHash !== state.artifactHash ||
      result.artifactRevision !== artifact.revision ||
      result.artifactHash !== artifact.hash
    )
      return decision('host_fix_receipt_required');
    return this.store.recordFix({
      workflowId,
      result,
      implementerSeatId: receipt.actorSeatId,
      usage: { attemptId, tokens: receipt.tokens, costUsd: receipt.costUsd },
    });
  }

  recordHostEvidence(
    context: ReviewContext,
    workflowId: string,
    evidenceId: string,
  ): Workflow | CoordinatorDecision {
    const state = this.scoped(context, workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    const evidence = this.host.evidence(context, evidenceId);
    if (!evidence || evidence.evidenceId !== evidenceId) return decision('host_evidence_required');
    return this.store.recordEvidence(workflowId, evidence, state.artifactHash, 'host');
  }

  finalize(context: ReviewContext, workflowId: string) {
    const state = this.scoped(context, workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    return this.store.finalize(workflowId);
  }
}
