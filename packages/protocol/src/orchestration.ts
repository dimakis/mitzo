import { z } from 'zod';
import { AccountBindingSchema } from './account-binding.js';
import type { ProviderAttemptToken, ProviderFailure } from './types.js';

const Id = z.string().trim().min(1);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const RevisionRefSchema = z.strictObject({ grantId: Id, revision: z.number().int().positive() });

/** Seat identity is independent of role, account, model and array position. */
export const MembershipReferenceSchema = z.strictObject({
  seatId: Id,
  membershipGeneration: z.number().int().nonnegative(),
});

/** Standalone conversations need no fabricated Telos, goal or task identity. */
export const OrchestrationIdentitySchema = z
  .strictObject({
    version: z.literal(1),
    conversationId: Id,
    telosItemId: Id.optional(),
    taskRootId: Id.optional(),
    taskNodeId: Id.optional(),
    goalId: Id.optional(),
    planRevision: Id.optional(),
    seat: MembershipReferenceSchema.optional(),
  })
  .refine((identity) => !identity.taskNodeId || !!identity.taskRootId, {
    message: 'Task node requires an explicit task root',
    path: ['taskRootId'],
  });

export const WorkOrderSchema = z.strictObject({
  version: z.literal(1),
  workOrderId: Id,
  identity: OrchestrationIdentitySchema,
  role: Id,
  policyRevision: Id,
  accountBinding: AccountBindingSchema,
  reasoningEffort: Id.nullable(),
  inputRevision: Id,
  inputHash: Sha256,
  contextGrant: RevisionRefSchema,
  authorityGrant: RevisionRefSchema,
  scopedFiles: z.array(Id),
  instructions: Id,
  expectedOutput: Id,
  acceptanceCriteria: z.array(Id).min(1),
  budget: z.strictObject({
    maxAttempts: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxCostUsd: z.number().nonnegative().nullable(),
  }),
});

export const AttemptStateSchema = z.enum([
  'queued',
  'claimed',
  'running',
  'recovery_required',
  'blocked',
  'failed',
  'completed',
  'cancelled',
]);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

/** ProviderAttemptToken remains the canonical provider identity. */
const ProviderAttemptTokenSchema = z.strictObject({
  sessionId: Id,
  executionId: Id,
  generation: z.number().int().positive(),
  providerAttemptId: Id,
  attempt: z.number().int().positive(),
});
export const OrchestrationAttemptSchema = z.strictObject({
  version: z.literal(1),
  attemptId: Id,
  workOrderId: Id,
  providerAttempt: ProviderAttemptTokenSchema,
  membership: MembershipReferenceSchema.optional(),
  state: AttemptStateSchema,
  inputRevision: Id,
  inputHash: Sha256,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type OrchestrationAttempt = z.infer<typeof OrchestrationAttemptSchema> & {
  providerAttempt: ProviderAttemptToken;
};

/** Completion of an attempt does not establish the desired outcome. */
export const WorkResultSchema = z.strictObject({
  version: z.literal(1),
  resultId: Id,
  attemptId: Id,
  inputRevision: Id,
  inputHash: Sha256,
  artifactRevision: Id,
  artifactHash: Sha256,
  summary: Id,
  evidenceRefs: z.array(Id),
  completedAt: z.number().int().nonnegative(),
});
export const OutcomeEvidenceSchema = z.strictObject({
  version: z.literal(1),
  evidenceId: Id,
  resultId: Id,
  criterion: Id,
  verdict: z.enum(['verified', 'failed', 'inconclusive']),
  artifactRevision: Id,
  evidenceRefs: z.array(Id),
  checkedAt: z.number().int().nonnegative(),
});
export const ApprovalDecisionSchema = z.strictObject({
  version: z.literal(1),
  approvalId: Id,
  workOrderId: Id,
  exactInputHash: Sha256,
  decision: z.enum(['approved', 'rejected', 'revoked']),
  actor: Id,
  decidedAt: z.number().int().nonnegative(),
});

/** Persist the stop fence before signaling the runtime. */
export const CancellationRecordSchema = z.strictObject({
  version: z.literal(1),
  cancellationId: Id,
  providerAttempt: ProviderAttemptTokenSchema,
  ownershipGeneration: z.number().int().nonnegative(),
  membership: MembershipReferenceSchema.optional(),
  actor: Id,
  reason: Id,
  idempotencyKey: Id,
  requestedAt: z.number().int().nonnegative(),
});

/** Evidence for reconciliation of the original provider attempt, not a retry. */
export const RecoveryRecordSchema = z.strictObject({
  version: z.literal(1),
  recoveryId: Id,
  providerAttempt: ProviderAttemptTokenSchema,
  ownershipGeneration: z.number().int().nonnegative(),
  membership: MembershipReferenceSchema.optional(),
  status: z.enum(['recovery_required', 'confirmed_completed', 'confirmed_failed', 'cancelled']),
  evidenceRefs: z.array(Id),
  observedAt: z.number().int().nonnegative(),
});

export const DispatchOperationSchema = z.strictObject({
  version: z.literal(1),
  key: Id,
  inputHash: Sha256,
  ownershipGeneration: z.number().int().nonnegative(),
  membership: MembershipReferenceSchema.optional(),
});
export type DispatchOperation = z.infer<typeof DispatchOperationSchema>;
export type DispatchDecision =
  { kind: 'admit' } | { kind: 'duplicate' } | { kind: 'conflict' } | { kind: 'stale_fence' };

/** Pure preflight only. The host must enforce the result with a durable atomic CAS
 * against the operation key, input hash, ownership and membership generations.
 */
export function admitDispatch(
  existing: DispatchOperation | undefined,
  proposed: DispatchOperation,
  current: {
    ownershipGeneration: number;
    membership?: {
      seatId: string;
      membershipGeneration: number;
      state: 'active' | 'suspended' | 'removed';
      reconciliation: 'pending' | 'confirmed' | 'recovery_required';
    };
  },
): DispatchDecision {
  DispatchOperationSchema.parse(proposed);
  if (
    proposed.ownershipGeneration !== current.ownershipGeneration ||
    (proposed.membership &&
      (proposed.membership.seatId !== current.membership?.seatId ||
        proposed.membership.membershipGeneration !== current.membership.membershipGeneration ||
        current.membership.state !== 'active' ||
        current.membership.reconciliation !== 'confirmed'))
  ) {
    return { kind: 'stale_fence' };
  }
  if (!existing) return { kind: 'admit' };
  DispatchOperationSchema.parse(existing);
  if (existing.key !== proposed.key) return { kind: 'conflict' };
  return existing.inputHash === proposed.inputHash &&
    existing.ownershipGeneration === proposed.ownershipGeneration &&
    existing.membership?.seatId === proposed.membership?.seatId &&
    existing.membership?.membershipGeneration === proposed.membership?.membershipGeneration
    ? { kind: 'duplicate' }
    : { kind: 'conflict' };
}

const ALLOWED: Record<AttemptState, readonly AttemptState[]> = {
  queued: ['claimed', 'blocked', 'cancelled'],
  claimed: ['running', 'recovery_required', 'blocked', 'failed', 'cancelled', 'completed'],
  running: ['recovery_required', 'blocked', 'failed', 'completed', 'cancelled'],
  recovery_required: ['completed', 'failed', 'cancelled'],
  blocked: [],
  failed: [],
  completed: [],
  cancelled: [],
};

export function transitionAttempt(
  attempt: OrchestrationAttempt,
  next: AttemptState,
  timestamp: number,
  currentMembershipGeneration?: number,
): OrchestrationAttempt {
  OrchestrationAttemptSchema.parse(attempt);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid attempt time');
  if (
    attempt.membership &&
    attempt.membership.membershipGeneration !== currentMembershipGeneration
  ) {
    throw new Error('Membership generation changed; execution is fenced');
  }
  if (timestamp < attempt.updatedAt) throw new Error('Attempt time cannot move backward');
  if (!ALLOWED[attempt.state].includes(next)) {
    throw new Error(`Invalid attempt transition ${attempt.state} → ${next}`);
  }
  return { ...attempt, state: next, updatedAt: timestamp };
}

/** Observation updates the original provider attempt. It never starts a new turn. */
export function reconcileProviderOutcome(
  attempt: OrchestrationAttempt,
  outcome: 'completed' | 'failed' | 'ambiguous',
  timestamp: number,
  currentMembershipGeneration?: number,
): OrchestrationAttempt {
  if (outcome === 'ambiguous' && attempt.state === 'recovery_required') {
    if (
      attempt.membership &&
      attempt.membership.membershipGeneration !== currentMembershipGeneration
    ) {
      throw new Error('Membership generation changed; recovery is fenced');
    }
    if (!Number.isSafeInteger(timestamp) || timestamp < attempt.updatedAt) {
      throw new Error('Invalid recovery time');
    }
    return attempt;
  }
  return transitionAttempt(
    attempt,
    outcome === 'ambiguous'
      ? 'recovery_required'
      : outcome === 'completed'
        ? 'completed'
        : 'failed',
    timestamp,
    currentMembershipGeneration,
  );
}

export type RetryDecision =
  | { kind: 'authorized' }
  | { kind: 'stale_fence' }
  | { kind: 'not_retryable' }
  | { kind: 'too_early'; retryAt: number }
  | { kind: 'authorization_required' }
  | { kind: 'confirmation_required' }
  | { kind: 'budget_exhausted' };

/** Pure policy preflight. A durable service allocates a new attempt and CASes budget. */
export function authorizeRetry(input: {
  attempt: OrchestrationAttempt;
  failure: ProviderFailure;
  failureObservedAt: number;
  now: number;
  retryRequested: boolean;
  confirmAmbiguous: boolean;
  budget: { attemptsUsed: number; maxAttempts: number };
  currentMembershipGeneration?: number;
}): RetryDecision {
  const {
    attempt,
    failure,
    failureObservedAt,
    now,
    retryRequested,
    confirmAmbiguous,
    budget,
    currentMembershipGeneration,
  } = input;
  OrchestrationAttemptSchema.parse(attempt);
  if (!Number.isSafeInteger(now) || now < attempt.updatedAt) throw new Error('Invalid retry time');
  if (
    !Number.isSafeInteger(failureObservedAt) ||
    failureObservedAt < attempt.createdAt ||
    failureObservedAt > now
  ) {
    throw new Error('Invalid failure observation time');
  }
  if (
    failure.retryAfterMs !== undefined &&
    (!Number.isSafeInteger(failure.retryAfterMs) || failure.retryAfterMs < 0)
  ) {
    throw new Error('Invalid retry-after delay');
  }
  if (
    !Number.isSafeInteger(budget.attemptsUsed) ||
    !Number.isSafeInteger(budget.maxAttempts) ||
    budget.attemptsUsed < 0 ||
    budget.maxAttempts < 1
  )
    throw new Error('Invalid retry budget');
  if (
    attempt.membership &&
    attempt.membership.membershipGeneration !== currentMembershipGeneration
  ) {
    return { kind: 'stale_fence' };
  }
  if (
    (attempt.state !== 'failed' && attempt.state !== 'recovery_required') ||
    !failure.retryable ||
    failure.attempt !== attempt.providerAttempt.attempt
  ) {
    return { kind: 'not_retryable' };
  }
  if (budget.attemptsUsed >= budget.maxAttempts) return { kind: 'budget_exhausted' };
  if (!retryRequested) return { kind: 'authorization_required' };
  const retryAt = failureObservedAt + (failure.retryAfterMs ?? 0);
  if (now < retryAt) return { kind: 'too_early', retryAt };
  if (failure.ambiguous && !confirmAmbiguous) return { kind: 'confirmation_required' };
  return { kind: 'authorized' };
}

export const HandoverManifestSchema = z
  .strictObject({
    version: z.literal(1),
    handoverId: Id,
    sourceConversationId: Id,
    successorConversationId: Id,
    packageHash: Sha256,
    inputRevisionHash: Sha256,
    sourceOwnershipGeneration: z.number().int().nonnegative(),
    successorOwnershipGeneration: z.number().int().positive(),
    sourceWorkOrderId: Id.optional(),
    grantRefs: z.array(RevisionRefSchema),
    budget: z.strictObject({
      maxAttempts: z.number().int().positive(),
      maxTokens: z.number().int().positive(),
      maxCostUsd: z.number().nonnegative().nullable(),
      attemptsUsed: z.number().int().nonnegative(),
      tokensUsed: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative().nullable(),
    }),
    state: z.enum(['prepared', 'transferring', 'recovery_required', 'completed', 'cancelled']),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.sourceConversationId === manifest.successorConversationId) {
      ctx.addIssue({ code: 'custom', message: 'Handover requires a distinct successor' });
    }
    if (manifest.successorOwnershipGeneration !== manifest.sourceOwnershipGeneration + 1) {
      ctx.addIssue({ code: 'custom', message: 'Handover ownership generation must advance once' });
    }
    if (
      manifest.budget.attemptsUsed > manifest.budget.maxAttempts ||
      manifest.budget.tokensUsed > manifest.budget.maxTokens ||
      (manifest.budget.maxCostUsd !== null &&
        manifest.budget.costUsd !== null &&
        manifest.budget.costUsd > manifest.budget.maxCostUsd)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Handover budget has already been exceeded' });
    }
    if (
      new Set(manifest.grantRefs.map((grant) => grant.grantId)).size !== manifest.grantRefs.length
    ) {
      ctx.addIssue({ code: 'custom', message: 'Handover grants must have unique IDs' });
    }
  });
export type HandoverManifest = z.infer<typeof HandoverManifestSchema>;

export function validateHandover(
  source: HandoverManifest,
  proposed: HandoverManifest,
): {
  kind:
    | 'valid'
    | 'stale_fence'
    | 'grant_change'
    | 'budget_reset'
    | 'package_change'
    | 'invalid_transition';
} {
  HandoverManifestSchema.parse(source);
  if (
    source.sourceOwnershipGeneration !== proposed.sourceOwnershipGeneration ||
    source.successorOwnershipGeneration !== proposed.successorOwnershipGeneration
  ) {
    return { kind: 'stale_fence' };
  }
  HandoverManifestSchema.parse(proposed);
  if (
    source.handoverId !== proposed.handoverId ||
    source.sourceWorkOrderId !== proposed.sourceWorkOrderId ||
    source.packageHash !== proposed.packageHash ||
    source.inputRevisionHash !== proposed.inputRevisionHash ||
    source.sourceConversationId !== proposed.sourceConversationId ||
    source.successorConversationId !== proposed.successorConversationId
  ) {
    return { kind: 'package_change' };
  }
  const grants = (refs: HandoverManifest['grantRefs']) =>
    JSON.stringify([...refs].sort((a, b) => a.grantId.localeCompare(b.grantId)));
  if (grants(source.grantRefs) !== grants(proposed.grantRefs)) return { kind: 'grant_change' };
  const transitions: Record<HandoverManifest['state'], readonly HandoverManifest['state'][]> = {
    prepared: ['transferring', 'cancelled'],
    transferring: ['completed', 'recovery_required', 'cancelled'],
    recovery_required: ['transferring', 'completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  if (source.state !== proposed.state && !transitions[source.state].includes(proposed.state)) {
    return { kind: 'invalid_transition' };
  }
  const a = source.budget,
    b = proposed.budget;
  if (
    b.maxAttempts > a.maxAttempts ||
    b.maxTokens > a.maxTokens ||
    (a.maxCostUsd !== null && (b.maxCostUsd === null || b.maxCostUsd > a.maxCostUsd)) ||
    b.attemptsUsed < a.attemptsUsed ||
    b.tokensUsed < a.tokensUsed ||
    (a.costUsd !== null && (b.costUsd === null || b.costUsd < a.costUsd))
  ) {
    return { kind: 'budget_reset' };
  }
  return { kind: 'valid' };
}
