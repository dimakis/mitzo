import type { OutcomeEvidenceSchema, WorkResultSchema } from '@mitzo/protocol';
import type { z } from 'zod';
import {
  isApplicationPolicy,
  type ApplicationAttempt,
  type ApplicationPolicy,
  SymposiumReviewStore,
} from './symposium-review-workflows.js';

type WorkResult = z.infer<typeof WorkResultSchema>;
type OutcomeEvidence = z.infer<typeof OutcomeEvidenceSchema>;
type Workflow = NonNullable<ReturnType<SymposiumReviewStore['get']>>;
type Roles = Parameters<SymposiumReviewStore['createWithPolicies']>[1];
type Limits = Workflow['limits'];
type Selection = Workflow['reviewer'];

export type ReviewContext = {
  owner: string;
  sessionId: string;
  /** Opaque request-scoped capability issued by trusted HTTP authentication wiring. Never persisted. */
  interactiveAuthorization?: object;
};
export type ReviewAttemptKind = 'initial' | 'review' | 'fix';
export type ReviewReceipt = {
  workflowId: string;
  attemptId: string;
  enforcementId?: string;
  policyReservationId?: string;
  operationId?: string;
  terminal: true;
  kind: ReviewAttemptKind;
  actorSeatId: string;
  artifactRevision: string;
  artifactHash: string;
  tokens: number | null;
  costUsd: number | null;
};

export type CompletedReview = Omit<Parameters<SymposiumReviewStore['recordReview']>[0], 'usage'> & {
  attemptId: string;
  enforcementId?: string;
  policyReservationId?: string;
};

/** Only a trusted host implementation may supply these facts. It never launches a provider call. */
export interface SymposiumReviewHost {
  prepareApplicationAttempt?(input: {
    context: ReviewContext;
    workflowId: string;
    attemptId: string;
    kind: 'initial' | 'review' | 'fix' | 'delta';
    selection: Selection;
    artifactRevision: string;
    artifactHash: string;
    policy: ApplicationPolicy;
  }): ApplicationAttempt | { kind: 'decision_required'; code: string };
  authorizeContinuation?(
    context: ReviewContext,
    workflowId: string,
    limits: ApplicationPolicy,
    reason: string,
  ): { authorizationId: string } | null;
  cancelApplicationAttempts?(context: ReviewContext, attempts: ApplicationAttempt[]): Promise<void>;
  /** Trusted imported artifact before the first implementation turn. */
  initialArtifact?(context: ReviewContext): { revision: string; hash: string };
  /** Host-attested output from the exact completed initial native operation. */
  initialResult?(context: ReviewContext, attemptId: string): WorkResult | null;
  completedImplementation(context: ReviewContext): WorkResult;
  currentArtifact(context: ReviewContext): { revision: string; hash: string };
  selectRoles(context: ReviewContext): Roles;
  /** Exact application pins already validated by the trusted host against current config and authority. */
  selectApplicationRoles?(context: ReviewContext): { implementer: Selection; reviewer: Selection };
  /** 'enforced' must mean native hard token/price caps, seat authority, and exact artifact
   * are bound to enforcementId. An estimate does not satisfy this contract.
   */
  prepareAttempt(input: {
    context: ReviewContext;
    workflowId: string;
    attemptId: string;
    kind: Exclude<ReviewAttemptKind, 'initial'>;
    selection: Selection;
    artifactRevision: string;
    artifactHash: string;
    remaining: { rounds: number; tokens: number; costUsd: number | null };
  }):
    | { kind: 'enforced'; enforcementId: string; maxTokens: number; maxCostUsd: number | null }
    | { kind: 'decision_required'; code: string };
  /** A receipt exists only after host-observed terminal provider completion.
   * Application mode permits explicitly unknown usage; native hard-cap mode requires final usage.
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
    if (isApplicationPolicy(input.limits) && this.host.selectApplicationRoles) {
      return this.store.create({
        workflowId: input.workflowId,
        owner: context.owner,
        sessionId: context.sessionId,
        implementation,
        acceptanceCriteria: input.acceptanceCriteria,
        limits: input.limits,
        ...this.host.selectApplicationRoles(context),
      });
    }
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

  startApplicationRun(
    context: ReviewContext,
    input: {
      workflowId: string;
      acceptanceCriteria: string[];
      limits: ApplicationPolicy;
      expectedArtifactRevision: string;
      expectedArtifactHash: string;
    },
  ): Workflow | CoordinatorDecision {
    if (!this.host?.initialArtifact) return decision('trusted_initial_host_unavailable');
    const existing = this.store.get(input.workflowId);
    if (existing) {
      this.scoped(context, input.workflowId);
      if (
        !existing.initialArtifact ||
        existing.initialArtifact.revision !== input.expectedArtifactRevision ||
        existing.initialArtifact.hash !== input.expectedArtifactHash ||
        JSON.stringify(existing.acceptanceCriteria) !== JSON.stringify(input.acceptanceCriteria) ||
        JSON.stringify(existing.limits) !== JSON.stringify(input.limits)
      )
        throw new Error('Application run idempotency conflict');
      return existing;
    }
    const initialArtifact = this.host.initialArtifact(context);
    const current = this.host.currentArtifact(context);
    if (
      initialArtifact.revision !== input.expectedArtifactRevision ||
      initialArtifact.hash !== input.expectedArtifactHash ||
      current.revision !== initialArtifact.revision ||
      current.hash !== initialArtifact.hash
    )
      return decision('artifact_changed');
    if (this.host.selectApplicationRoles) {
      return this.store.createApplicationRun({
        workflowId: input.workflowId,
        owner: context.owner,
        sessionId: context.sessionId,
        initialArtifact,
        acceptanceCriteria: input.acceptanceCriteria,
        limits: input.limits,
        ...this.host.selectApplicationRoles(context),
      });
    }
    return this.store.createApplicationRunWithPolicies(
      {
        workflowId: input.workflowId,
        owner: context.owner,
        sessionId: context.sessionId,
        initialArtifact,
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
        enforcementId?: string;
        policyReservationId?: string;
        applicationAttempt?: ApplicationAttempt;
        selection: Selection;
        artifactRevision: string;
        artifactHash: string;
      } {
    const state = this.scoped(context, workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    const selection = kind === 'review' ? state.reviewer : state.implementer;
    if (isApplicationPolicy(state.limits)) {
      if (!this.host.prepareApplicationAttempt)
        return decision('application_policy_host_unavailable');
      const prepared = this.host.prepareApplicationAttempt({
        context,
        workflowId,
        attemptId,
        kind: kind === 'review' && state.status === 'awaiting_delta_review' ? 'delta' : kind,
        selection,
        artifactRevision: state.artifactRevision,
        artifactHash: state.artifactHash,
        policy: state.limits,
      });
      if ('code' in prepared) return prepared;
      if (
        prepared.kind !==
          (kind === 'review' && state.status === 'awaiting_delta_review' ? 'delta' : kind) ||
        prepared.workflowId !== workflowId ||
        prepared.attemptId !== attemptId ||
        prepared.actorSeatId !== selection.seatId ||
        prepared.artifactRevision !== state.artifactRevision ||
        prepared.artifactHash !== state.artifactHash
      )
        return decision('application_binding_mismatch');
      const admitted = this.store.reserveApplicationAttempt(prepared);
      if (admitted.kind !== 'admitted') return admitted;
      return {
        kind: 'reserved_not_dispatched',
        attemptId,
        policyReservationId: prepared.policyReservationId,
        applicationAttempt: prepared,
        selection,
        artifactRevision: state.artifactRevision,
        artifactHash: state.artifactHash,
      };
    }
    if (kind === 'initial') return decision('application_policy_required');
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

  private matchesReservation(state: Workflow, receipt: ReviewReceipt): boolean {
    if (isApplicationPolicy(state.limits)) {
      const attempt = state.applicationAttempts.find((a) => a.attemptId === receipt.attemptId);
      return Boolean(
        attempt?.dispatched &&
        attempt.policyReservationId === receipt.policyReservationId &&
        attempt.operationId &&
        attempt.operationId === receipt.operationId,
      );
    }
    return Boolean(
      receipt.enforcementId &&
      receipt.enforcementId ===
        state.reservations.find((a) => a.attemptId === receipt.attemptId)?.enforcementId &&
      receipt.tokens !== null,
    );
  }

  async stop(context: ReviewContext, workflowId: string) {
    this.scoped(context, workflowId);
    const state = this.store.stopApplication(workflowId, context.owner, 'user_stop');
    const pending = state.applicationAttempts.filter((a) => !a.settled);
    await this.host?.cancelApplicationAttempts?.(context, pending);
    return this.scoped(context, workflowId);
  }

  continue(context: ReviewContext, workflowId: string, limits: ApplicationPolicy, reason: string) {
    this.scoped(context, workflowId);
    const authorization = this.host?.authorizeContinuation?.(context, workflowId, limits, reason);
    if (!authorization) return decision('interactive_continuation_authority_required');
    return this.store.continueApplication({
      workflowId,
      actor: context.owner,
      limits,
      reason,
      ...authorization,
    });
  }

  recordInitialResult(
    context: ReviewContext,
    workflowId: string,
    attemptId: string,
  ): Workflow | CoordinatorDecision {
    const state = this.scoped(context, workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    const receipt = this.host.receipt(context, attemptId);
    const result = this.host.initialResult?.(context, attemptId);
    const artifact = this.host.currentArtifact(context);
    const attempt = state.applicationAttempts.find((a) => a.attemptId === attemptId);
    if (
      !receipt ||
      !result ||
      !isApplicationPolicy(state.limits) ||
      receipt.terminal !== true ||
      receipt.workflowId !== workflowId ||
      receipt.attemptId !== attemptId ||
      !this.matchesReservation(state, receipt) ||
      receipt.kind !== 'initial' ||
      receipt.actorSeatId !== state.implementer.seatId ||
      !attempt ||
      (attempt.effectiveKind ?? attempt.kind) !== 'initial' ||
      receipt.artifactRevision !== attempt.artifactRevision ||
      receipt.artifactHash !== attempt.artifactHash ||
      !receipt.policyReservationId ||
      !receipt.operationId ||
      result.attemptId !== attemptId ||
      result.inputRevision !== attempt.artifactRevision ||
      result.inputHash !== attempt.artifactHash ||
      result.artifactRevision !== artifact.revision ||
      result.artifactHash !== artifact.hash
    )
      return decision('host_initial_receipt_required');
    return this.store.recordInitialResult({
      workflowId,
      result,
      implementerSeatId: receipt.actorSeatId,
      policyReservationId: receipt.policyReservationId,
      operationId: receipt.operationId,
      usage: { attemptId, tokens: receipt.tokens, costUsd: receipt.costUsd },
    });
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
      !this.matchesReservation(state, receipt) ||
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
      review.policyReservationId !== receipt.policyReservationId ||
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

  dismissFinding(
    context: ReviewContext,
    input: { workflowId: string; fingerprint: string; reason: string; evidenceRefs: string[] },
  ): Workflow | CoordinatorDecision {
    const state = this.scoped(context, input.workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    return this.store.dismissFinding({
      ...input,
      actor: context.owner,
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
      !this.matchesReservation(state, receipt) ||
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

  exportRecord(context: ReviewContext, workflowId: string) {
    const finalized = this.finalize(context, workflowId);
    if (finalized.kind !== 'verified') return finalized;
    const artifactChanged = new Error('Artifact changed during record export');
    try {
      const record = this.store.exportVerifiedRecord(
        {
          owner: context.owner,
          sessionId: context.sessionId,
          workflowId,
          artifactRevision: finalized.artifactRevision,
          artifactHash: finalized.artifactHash,
        },
        () => {
          // Keep the final host check inside the storage transaction so a failed
          // gate cannot leave a newly persisted permanent record behind.
          if (!this.current(context, this.scoped(context, workflowId))) throw artifactChanged;
        },
      );
      return { ...finalized, record };
    } catch (error) {
      if (error === artifactChanged) return decision('artifact_changed');
      throw error;
    }
  }

  finalize(context: ReviewContext, workflowId: string) {
    const state = this.scoped(context, workflowId);
    if (!this.host) return decision('trusted_review_host_unavailable');
    if (!this.current(context, state)) return decision('artifact_changed');
    return this.store.finalize(workflowId);
  }
}
