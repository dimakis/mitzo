import { describe, expect, it } from 'vitest';
import {
  OrchestrationIdentitySchema,
  WorkOrderSchema,
  admitDispatch,
  transitionAttempt,
  reconcileProviderOutcome,
  authorizeRetry,
  CancellationRecordSchema,
  RecoveryRecordSchema,
  WorkResultSchema,
  OutcomeEvidenceSchema,
  ApprovalDecisionSchema,
  HandoverManifestSchema,
  validateHandover,
} from '../src/orchestration.js';

const binding = {
  accountId: 'work',
  accountLabel: 'Work',
  provider: 'openai-codex' as const,
  model: 'gpt-6-sol',
  profileRevision: 'account-r1',
};
const identity = { version: 1 as const, conversationId: 'conversation-1' };
const seat = { seatId: 'reviewer-7', membershipGeneration: 3 };
const workOrder = {
  version: 1 as const,
  workOrderId: 'order-1',
  identity: { ...identity, seat },
  role: 'reviewer',
  policyRevision: 'policy-r2',
  accountBinding: binding,
  reasoningEffort: 'high',
  inputRevision: 'commit:abc123',
  inputHash: 'a'.repeat(64),
  contextGrant: { grantId: 'context-1', revision: 2 },
  authorityGrant: { grantId: 'authority-1', revision: 4 },
  scopedFiles: ['src/chat.ts'],
  instructions: 'Review the proposed change.',
  expectedOutput: 'Findings with evidence',
  acceptanceCriteria: ['Each finding cites a line or behavior'],
  budget: { maxAttempts: 2, maxTokens: 20_000, maxCostUsd: 10 },
};
const attempt = {
  version: 1 as const,
  attemptId: 'attempt-1',
  workOrderId: workOrder.workOrderId,
  providerAttempt: {
    sessionId: identity.conversationId,
    executionId: 'execution-1',
    generation: 1,
    providerAttemptId: 'provider-attempt-1',
    attempt: 1,
  },
  membership: seat,
  ownershipGeneration: 4,
  state: 'queued' as const,
  inputRevision: workOrder.inputRevision,
  inputHash: workOrder.inputHash,
  createdAt: 1,
  updatedAt: 1,
};
const fence = {
  ownershipGeneration: 4,
  inputRevision: workOrder.inputRevision,
  inputHash: workOrder.inputHash,
  membership: seat,
};

describe('O0 identities and work orders', () => {
  it('permits standalone Symposium conversations without fabricated Telos or task IDs', () => {
    expect(OrchestrationIdentitySchema.parse(identity)).toEqual(identity);
    expect(WorkOrderSchema.parse(workOrder)).toEqual(workOrder);
  });

  it('requires an explicit task root for a task node and stable seat generation', () => {
    expect(() =>
      OrchestrationIdentitySchema.parse({ ...identity, taskNodeId: 'node-1' }),
    ).toThrow();
    expect(() =>
      OrchestrationIdentitySchema.parse({ ...identity, seat: { seatId: 'reviewer-7' } }),
    ).toThrow();
    expect(
      OrchestrationIdentitySchema.parse({
        ...identity,
        taskRootId: 'root-1',
        taskNodeId: 'node-1',
      }),
    ).toBeDefined();
  });

  it('keeps account, model, policy and grants pinned independently', () => {
    expect(() =>
      WorkOrderSchema.parse({ ...workOrder, accountBinding: { ...binding, provider: 'unknown' } }),
    ).toThrow();
    expect(() => WorkOrderSchema.parse({ ...workOrder, budget: { maxAttempts: 0 } })).toThrow();
  });
});

describe('O0 dispatch and attempt transitions', () => {
  it('returns a pure decision for idempotent, conflicting and stale dispatches', () => {
    const operation = {
      version: 1 as const,
      key: 'dispatch-1',
      inputHash: workOrder.inputHash,
      ownershipGeneration: 4,
      membership: seat,
    };
    const current = {
      ownershipGeneration: 4,
      membership: { ...seat, state: 'active' as const, reconciliation: 'confirmed' as const },
    };
    expect(admitDispatch(undefined, operation, current)).toEqual({ kind: 'admit' });
    expect(admitDispatch(operation, operation, current)).toEqual({ kind: 'duplicate' });
    expect(admitDispatch(operation, { ...operation, inputHash: 'b'.repeat(64) }, current)).toEqual({
      kind: 'conflict',
    });
    expect(
      admitDispatch(undefined, operation, {
        ...current,
        membership: { ...current.membership, membershipGeneration: 5 },
      }),
    ).toEqual({ kind: 'stale_fence' });
    expect(
      admitDispatch(undefined, operation, {
        ...current,
        membership: { ...current.membership, seatId: 'other' },
      }),
    ).toEqual({ kind: 'stale_fence' });
    expect(
      admitDispatch(undefined, operation, {
        ...current,
        membership: { ...current.membership, state: 'suspended' as const },
      }),
    ).toEqual({ kind: 'stale_fence' });
    expect(
      admitDispatch(undefined, operation, {
        ...current,
        membership: { ...current.membership, reconciliation: 'pending' as const },
      }),
    ).toEqual({ kind: 'stale_fence' });
    expect(admitDispatch(undefined, { ...operation, membership: undefined }, current)).toEqual({
      kind: 'stale_fence',
    });
  });

  it('fences stale membership and never reopens a terminal attempt', () => {
    expect(transitionAttempt(attempt, 'claimed', 2, fence).state).toBe('claimed');
    expect(() =>
      transitionAttempt(attempt, 'claimed', 2, {
        ...fence,
        membership: { ...seat, membershipGeneration: 4 },
      }),
    ).toThrow(/generation/i);
    expect(() =>
      transitionAttempt(attempt, 'claimed', 2, { ...fence, ownershipGeneration: 5 }),
    ).toThrow(/ownership/i);
    expect(() =>
      transitionAttempt(attempt, 'claimed', 2, { ...fence, inputRevision: 'new-revision' }),
    ).toThrow(/input/i);
    expect(() =>
      transitionAttempt(attempt, 'claimed', 2, { ...fence, inputHash: 'f'.repeat(64) }),
    ).toThrow(/input/i);
    const completed = transitionAttempt(
      transitionAttempt(attempt, 'claimed', 2, fence),
      'completed',
      3,
      fence,
    );
    expect(() => transitionAttempt(completed, 'running', 4, fence)).toThrow();
    expect(() => transitionAttempt(attempt, 'claimed', Number.NaN, fence)).toThrow(/time/i);
  });

  it('reconciles an ambiguous provider outcome on the same attempt; retry needs explicit authorization', () => {
    const running = transitionAttempt(
      transitionAttempt(attempt, 'claimed', 2, fence),
      'running',
      3,
      fence,
    );
    const uncertain = reconcileProviderOutcome(running, 'ambiguous', 4, fence);
    expect(uncertain.state).toBe('recovery_required');
    expect(uncertain.providerAttempt.providerAttemptId).toBe(
      attempt.providerAttempt.providerAttemptId,
    );
    expect(reconcileProviderOutcome(uncertain, 'ambiguous', 5, fence)).toEqual(uncertain);
    expect(() =>
      reconcileProviderOutcome(uncertain, 'completed', 5, {
        ...fence,
        inputRevision: 'new-revision',
      }),
    ).toThrow(/input/i);
    const failure = {
      category: 'transport' as const,
      retryable: true,
      ambiguous: true,
      attempt: 1,
      correlationId: 'corr-1',
      message: 'Connection lost',
      retryAfterMs: 2000,
    };
    const retryInput = {
      attempt: uncertain,
      failure,
      failureObservedAt: 4,
      now: 5,
      retryRequested: true,
      confirmAmbiguous: false,
      budget: { attemptsUsed: 1, maxAttempts: 2 },
      current: fence,
    };
    expect(authorizeRetry(retryInput)).toEqual({ kind: 'too_early', retryAt: 2004 });
    expect(authorizeRetry({ ...retryInput, now: 2004 })).toEqual({ kind: 'confirmation_required' });
    expect(authorizeRetry({ ...retryInput, now: 2004, retryRequested: false })).toEqual({
      kind: 'authorization_required',
    });
    expect(authorizeRetry({ ...retryInput, now: 2004, confirmAmbiguous: true })).toEqual({
      kind: 'authorized',
    });
    expect(
      authorizeRetry({
        ...retryInput,
        now: 2004,
        confirmAmbiguous: true,
        budget: { attemptsUsed: 2, maxAttempts: 2 },
      }),
    ).toEqual({ kind: 'budget_exhausted' });
    expect(
      authorizeRetry({ ...retryInput, now: 2004, failure: { ...failure, retryable: false } }),
    ).toEqual({ kind: 'not_retryable' });
    expect(
      authorizeRetry({
        ...retryInput,
        now: 2004,
        retryRequested: false,
        failure: { ...failure, ambiguous: false },
      }),
    ).toEqual({ kind: 'authorization_required' });
    expect(
      authorizeRetry({ ...retryInput, now: 2004, failure: { ...failure, ambiguous: false } }),
    ).toEqual({ kind: 'confirmation_required' });
    expect(() =>
      authorizeRetry({ ...retryInput, failure: { ...failure, retryAfterMs: Number.NaN } }),
    ).toThrow(/retry-after/i);
  });

  it('pins cancellation and recovery to the original provider attempt and ownership fence', () => {
    const target = { ...attempt.providerAttempt };
    expect(
      CancellationRecordSchema.parse({
        version: 1,
        cancellationId: 'cancel-1',
        providerAttempt: target,
        ownershipGeneration: 4,
        membership: seat,
        actor: 'human-1',
        reason: 'Stop review',
        idempotencyKey: 'stop-1',
        requestedAt: 7,
      }).providerAttempt,
    ).toEqual(target);
    expect(
      RecoveryRecordSchema.parse({
        version: 1,
        recoveryId: 'recovery-1',
        providerAttempt: target,
        ownershipGeneration: 4,
        membership: seat,
        status: 'recovery_required',
        evidenceRefs: [],
        observedAt: 8,
      }).status,
    ).toBe('recovery_required');
  });
});

describe('O0 result and evidence', () => {
  it('keeps result completion, approval and outcome verification separate and revision-pinned', () => {
    const result = WorkResultSchema.parse({
      version: 1,
      resultId: 'result-1',
      attemptId: attempt.attemptId,
      inputRevision: workOrder.inputRevision,
      inputHash: workOrder.inputHash,
      artifactRevision: 'commit:def456',
      artifactHash: 'e'.repeat(64),
      summary: 'Implemented the change',
      evidenceRefs: ['test:42'],
      completedAt: 10,
    });
    expect(result.artifactRevision).toBe('commit:def456');
    const evidence = OutcomeEvidenceSchema.parse({
      version: 1,
      evidenceId: 'evidence-1',
      resultId: result.resultId,
      criterion: workOrder.acceptanceCriteria[0],
      verdict: 'inconclusive',
      artifactRevision: result.artifactRevision,
      evidenceRefs: [],
      checkedAt: 11,
    });
    expect(evidence.verdict).toBe('inconclusive');
    expect(
      ApprovalDecisionSchema.parse({
        version: 1,
        approvalId: 'approval-1',
        workOrderId: workOrder.workOrderId,
        exactInputHash: workOrder.inputHash,
        decision: 'approved',
        actor: 'human-1',
        decidedAt: 3,
      }).decision,
    ).toBe('approved');
  });
});

describe('O0 handover', () => {
  const manifest = {
    version: 1 as const,
    handoverId: 'handover-1',
    sourceConversationId: 'conversation-1',
    successorConversationId: 'conversation-2',
    packageHash: 'c'.repeat(64),
    inputRevisionHash: 'd'.repeat(64),
    sourceOwnershipGeneration: 7,
    successorOwnershipGeneration: 8,
    sourceWorkOrderId: 'order-1',
    grantRefs: [{ grantId: 'authority-1', revision: 4 }],
    budget: {
      maxAttempts: 2,
      maxTokens: 20_000,
      maxCostUsd: 10,
      attemptsUsed: 1,
      tokensUsed: 8_000,
      costUsd: 2,
    },
    state: 'prepared' as const,
  };

  it('pins package/input revisions and transfers ownership without minting grants or budget', () => {
    expect(HandoverManifestSchema.parse(manifest)).toEqual(manifest);
    expect(validateHandover(manifest, manifest)).toEqual({ kind: 'valid' });
    expect(
      validateHandover(manifest, { ...manifest, grantRefs: [{ grantId: 'new', revision: 1 }] }),
    ).toEqual({ kind: 'grant_change' });
    expect(
      validateHandover(manifest, { ...manifest, budget: { ...manifest.budget, tokensUsed: 0 } }),
    ).toEqual({ kind: 'budget_reset' });
    expect(validateHandover(manifest, { ...manifest, sourceOwnershipGeneration: 6 })).toEqual({
      kind: 'stale_fence',
    });
    expect(validateHandover(manifest, { ...manifest, handoverId: 'other' })).toEqual({
      kind: 'package_change',
    });
    expect(validateHandover(manifest, { ...manifest, sourceWorkOrderId: 'other' })).toEqual({
      kind: 'package_change',
    });
    expect(validateHandover({ ...manifest, state: 'completed' }, manifest)).toEqual({
      kind: 'invalid_transition',
    });
    expect(validateHandover(manifest, { ...manifest, state: 'transferring' })).toEqual({
      kind: 'valid',
    });
    expect(() =>
      HandoverManifestSchema.parse({
        ...manifest,
        grantRefs: [manifest.grantRefs[0], manifest.grantRefs[0]],
      }),
    ).toThrow();
    expect(
      HandoverManifestSchema.parse({ ...manifest, budget: { ...manifest.budget, costUsd: null } })
        .budget.costUsd,
    ).toBeNull();
    expect(
      validateHandover(manifest, { ...manifest, budget: { ...manifest.budget, costUsd: null } }),
    ).toEqual({ kind: 'budget_reset' });
  });
});
