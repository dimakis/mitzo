import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { AccountProfiles } from '../account-profiles.js';
import { ExecutionPolicySchema } from '@mitzo/protocol';

const hash = (letter: string) => letter.repeat(64);
const implementation = {
  version: 1 as const,
  resultId: 'implementation-1',
  attemptId: 'implementer-1',
  inputRevision: 'input-1',
  inputHash: hash('a'),
  artifactRevision: 'commit-1',
  artifactHash: hash('b'),
  summary: 'Implemented feature',
  evidenceRefs: ['commit-1'],
  completedAt: 1,
};
const selection = (seatId: string, role: string) => ({
  seatId,
  role,
  selectionId: `${seatId}-policy-selection`,
  policyRevision: 'policy-1',
  profileId: role,
  profileRevision: 1,
  accountId: `${seatId}-account`,
  model: `${seatId}-model`,
});
const create = (extra = {}) => ({
  workflowId: 'workflow-1',
  owner: 'owner',
  sessionId: 'session-1',
  implementation,
  implementer: selection('coder', 'coder'),
  reviewer: selection('reviewer', 'reviewer'),
  acceptanceCriteria: ['Criterion A'],
  limits: { maxReviewRounds: 2, maxTokens: 500, maxCostUsd: 1 },
  ...extra,
});
const usage = (attemptId: string, tokens = 50, costUsd: number | null = 0.1) => ({
  attemptId,
  tokens,
  costUsd,
});
const finding = {
  criterion: 'Criterion A',
  summary: 'Missing error branch',
  location: 'server/feature.ts:10',
  evidenceRefs: ['diff:10'],
};

let directory: string;
let reviews: SymposiumReviewStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-review-'));
  reviews = new SymposiumReviewStore(join(directory, 'events.db'));
});
afterEach(() => {
  reviews.close();
  rmSync(directory, { recursive: true, force: true });
});

const recordReview = (input: Parameters<SymposiumReviewStore['recordReview']>[0]) => {
  const state = reviews.get(input.workflowId)!;
  const existing = state.reservations.find((entry) => entry.attemptId === input.usage.attemptId);
  const admission = reviews.admitAttempt({
    workflowId: input.workflowId,
    attemptId: input.usage.attemptId,
    enforcementId: `cap-${input.usage.attemptId}`,
    kind: 'review',
    actorSeatId: input.reviewerSeatId,
    artifactRevision: input.artifactRevision,
    artifactHash: input.artifactHash,
    maxTokens:
      existing?.maxTokens ??
      Math.max(1, Math.min(input.usage.tokens, state.limits.maxTokens - state.tokensUsed)),
    maxCostUsd:
      existing?.maxCostUsd ??
      (input.usage.costUsd === null
        ? null
        : state.limits.maxCostUsd === null
          ? input.usage.costUsd
          : Math.min(input.usage.costUsd, state.limits.maxCostUsd - state.costUsd)),
  });
  if (admission.kind === 'decision_required')
    throw new Error(`Review admission: ${admission.code}`);
  return reviews.recordReview(input);
};
const recordFix = (input: Parameters<SymposiumReviewStore['recordFix']>[0]) => {
  const admission = reviews.admitAttempt({
    workflowId: input.workflowId,
    attemptId: input.usage.attemptId,
    enforcementId: `cap-${input.usage.attemptId}`,
    kind: 'fix',
    actorSeatId: input.implementerSeatId,
    artifactRevision: input.result.inputRevision,
    artifactHash: input.result.inputHash,
    maxTokens: Math.max(input.usage.tokens, 1),
    maxCostUsd: input.usage.costUsd,
  });
  if (admission.kind === 'decision_required') throw new Error(`Fix admission: ${admission.code}`);
  return reviews.recordFix(input);
};

describe('artifact-pinned Symposium review workflow', () => {
  it('keeps a reserved artifact stable until its old receipt settles', () => {
    reviews.create(create());
    reviews.admitAttempt({
      workflowId: 'workflow-1',
      attemptId: 'reviewer-1',
      enforcementId: 'cap-reviewer-1',
      kind: 'review',
      actorSeatId: 'reviewer',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      maxTokens: 50,
      maxCostUsd: 0.1,
    });
    const changed = {
      ...implementation,
      inputRevision: 'commit-1',
      inputHash: hash('b'),
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
    };
    expect(() => reviews.advanceArtifact('workflow-1', changed)).toThrow(/in.flight|settle/i);
    reviews.recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    expect(reviews.advanceArtifact('workflow-1', changed)).toMatchObject({
      artifactRevision: 'commit-2',
      status: 'awaiting_review',
    });
  });

  it('supersedes old open findings when an externally changed artifact gets a full review', () => {
    reviews.create(create());
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [finding],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    reviews.advanceArtifact('workflow-1', {
      ...implementation,
      inputRevision: 'commit-1',
      inputHash: hash('b'),
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
    });
    const result = recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-2',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-2'),
    });
    expect(result.status).toBe('awaiting_evidence');
    expect(result.findings[0].status).toBe('superseded');
  });

  it('requires fix authority before reserving a native fix attempt', () => {
    reviews.create(create());
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [finding],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    expect(() =>
      reviews.admitAttempt({
        workflowId: 'workflow-1',
        attemptId: 'unauthorized-fix',
        enforcementId: 'cap-unauthorized-fix',
        kind: 'fix',
        actorSeatId: 'coder',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        maxTokens: 20,
        maxCostUsd: 0.1,
      }),
    ).toThrow(/authority/i);
    expect(reviews.get('workflow-1')!.reservations).toHaveLength(1);
  });

  it('does not admit a zero-priced estimate after exhausting the cost ceiling', () => {
    reviews.create(create({ limits: { maxReviewRounds: 2, maxTokens: 500, maxCostUsd: 0 } }));
    expect(
      reviews.admitAttempt({
        workflowId: 'workflow-1',
        attemptId: 'free-estimate',
        enforcementId: 'cap-free-estimate',
        kind: 'review',
        actorSeatId: 'reviewer',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        maxTokens: 20,
        maxCostUsd: 0,
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'cost_budget_exhausted' });
  });

  it('admits coder and independent reviewer only from approved O1 role selections', () => {
    const accounts = new AccountProfiles([
      {
        id: 'work',
        label: 'Work',
        provider: 'anthropic-vertex',
        projectId: 'p',
        region: 'r',
        credentialRef: '/tmp/test-adc',
        models: [
          { id: 'coder', label: 'Coder' },
          { id: 'reviewer', label: 'Reviewer' },
        ],
      },
    ]);
    const policyInput = (role: 'coder' | 'reviewer', profileRevision = '1') => ({
      policy: ExecutionPolicySchema.parse({
        version: 1,
        policyId: `${role}-policy`,
        revision: 'policy-1',
        role,
        profileBinding: { profileId: role, profileRevision },
        primary: { accountId: 'work', model: role, reasoningEffort: null },
        alternatives: [],
        contextGrant: { grantId: 'context', revision: 1 },
        authorityGrant: { grantId: 'authority', revision: 1 },
        requiredCapabilities: { tools: false, context: false, route: true },
        limits: {
          maxAttempts: 2,
          maxTokens: 500,
          maxCostUsd: 1,
          maxReplans: 0,
          maxFallbacks: 0,
          maxEscalations: 0,
          unknownCostPolicy: 'decision',
        },
      }),
      accountProfiles: accounts,
      capabilities: () => ({ tools: true, context: true, route: true }),
      pricing: () => ({ kind: 'known' as const, maxUsdPerMillionTokens: 1 }),
      usage: { attempts: 0, tokens: 0, costUsd: 0, replans: 0, fallbacks: 0, escalations: 0 },
    });
    const base = create();
    const withoutSelections = {
      workflowId: base.workflowId,
      owner: base.owner,
      sessionId: base.sessionId,
      implementation: base.implementation,
      acceptanceCriteria: base.acceptanceCriteria,
      limits: base.limits,
    };
    const roles = {
      implementer: {
        seatId: 'coder',
        selectionId: 'coder-policy-selection',
        profileRevision: 1,
        policyInput: policyInput('coder'),
      },
      reviewer: {
        seatId: 'reviewer',
        selectionId: 'reviewer-policy-selection',
        profileRevision: 1,
        policyInput: policyInput('reviewer'),
      },
    };
    expect(reviews.createWithPolicies(withoutSelections, roles)).toMatchObject({
      implementer: { accountId: 'work', model: 'coder', profileRevision: 1 },
      reviewer: { accountId: 'work', model: 'reviewer', profileRevision: 1 },
    });
    expect(() =>
      reviews.createWithPolicies(
        { ...withoutSelections, workflowId: 'bad-profile' },
        {
          ...roles,
          reviewer: { ...roles.reviewer, policyInput: policyInput('reviewer', '2') },
        },
      ),
    ).toThrow(/profile/i);
    expect(() =>
      reviews.createWithPolicies(
        { ...withoutSelections, workflowId: 'bad-seat' },
        {
          ...roles,
          reviewer: { ...roles.reviewer, seatId: 'coder' },
        },
      ),
    ).toThrow(/independent/i);
  });
  it('requires an independently selected reviewer and a completed pinned implementation', () => {
    expect(() => reviews.create(create({ reviewer: selection('coder', 'reviewer') }))).toThrow(
      /independent/i,
    );
    expect(() => reviews.create(create({ reviewer: selection('reviewer', 'coder') }))).toThrow(
      /reviewer/i,
    );
    expect(reviews.create(create())).toMatchObject({
      workflowId: 'workflow-1',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      status: 'awaiting_review',
    });
  });

  it('refuses a review receipt without its matching pre-dispatch reservation', () => {
    reviews.create(create());
    expect(() =>
      reviews.recordReview({
        workflowId: 'workflow-1',
        reviewId: 'review-1',
        reviewerSeatId: 'reviewer',
        kind: 'full',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        findings: [],
        resolvedFingerprints: [],
        usage: usage('reviewer-1'),
      }),
    ).toThrow(/reservation/i);
  });

  it('deduplicates repeated findings, requires fix authority, and verifies only after delta and host evidence', () => {
    reviews.create(create());
    const first = recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [finding, finding],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0].status).toBe('open');
    const fingerprint = first.findings[0].fingerprint;
    const fix = {
      ...implementation,
      resultId: 'fix-1',
      attemptId: 'implementer-2',
      inputRevision: 'commit-1',
      inputHash: hash('b'),
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
      completedAt: 2,
    };
    expect(() =>
      recordFix({
        workflowId: 'workflow-1',
        result: fix,
        implementerSeatId: 'coder',
        usage: usage('implementer-2'),
      }),
    ).toThrow(/authority/i);
    reviews.authorizeFix({
      workflowId: 'workflow-1',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      actor: 'owner',
      authorityGrantId: 'grant-1',
      authorityRevision: 1,
      findingFingerprints: [fingerprint],
      reason: 'Fix finding',
    });
    expect(
      recordFix({
        workflowId: 'workflow-1',
        result: fix,
        implementerSeatId: 'coder',
        usage: usage('implementer-2'),
      }),
    ).toMatchObject({
      artifactRevision: 'commit-2',
      status: 'awaiting_delta_review',
    });
    const retryFix = {
      workflowId: 'workflow-1',
      result: fix,
      implementerSeatId: 'coder',
      usage: usage('implementer-2'),
    };
    expect(reviews.recordFix(retryFix)).toMatchObject({
      artifactRevision: 'commit-2',
      status: 'awaiting_delta_review',
    });
    expect(() => reviews.recordFix({ ...retryFix, usage: usage('implementer-2', 99) })).toThrow(
      /idempotency/i,
    );
    expect(() =>
      recordReview({
        workflowId: 'workflow-1',
        reviewId: 'stale',
        reviewerSeatId: 'reviewer',
        kind: 'delta',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        findings: [],
        resolvedFingerprints: [fingerprint],
        usage: usage('reviewer-stale'),
      }),
    ).toThrow(/stale|artifact/i);
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-2',
      reviewerSeatId: 'reviewer',
      kind: 'delta',
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
      findings: [],
      resolvedFingerprints: [fingerprint],
      usage: usage('reviewer-2'),
    });
    expect(reviews.finalize('workflow-1')).toMatchObject({
      kind: 'decision_required',
      code: 'missing_evidence',
    });
    reviews.recordEvidence(
      'workflow-1',
      {
        version: 1,
        evidenceId: 'model-agreement',
        resultId: 'fix-1',
        criterion: 'Criterion A',
        verdict: 'verified',
        artifactRevision: 'commit-2',
        evidenceRefs: ['reviewer-says-yes'],
        checkedAt: 3,
      },
      hash('c'),
      'model',
    );
    expect(reviews.finalize('workflow-1')).toMatchObject({
      kind: 'decision_required',
      code: 'missing_evidence',
    });
    reviews.recordEvidence(
      'workflow-1',
      {
        version: 1,
        evidenceId: 'host-test',
        resultId: 'fix-1',
        criterion: 'Criterion A',
        verdict: 'verified',
        artifactRevision: 'commit-2',
        evidenceRefs: ['test-run:123'],
        checkedAt: 4,
      },
      hash('c'),
      'host',
    );
    expect(reviews.finalize('workflow-1')).toMatchObject({
      kind: 'verified',
      artifactRevision: 'commit-2',
    });
    expect(reviews.get('workflow-1')?.findings[0]).toMatchObject({ fingerprint, status: 'fixed' });
  });

  it('invalidates old reviews and evidence when the input artifact changes', () => {
    reviews.create(create());
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    reviews.recordEvidence(
      'workflow-1',
      {
        version: 1,
        evidenceId: 'host-1',
        resultId: 'implementation-1',
        criterion: 'Criterion A',
        verdict: 'verified',
        artifactRevision: 'commit-1',
        evidenceRefs: ['test-run:1'],
        checkedAt: 2,
      },
      hash('b'),
      'host',
    );
    reviews.advanceArtifact('workflow-1', {
      ...implementation,
      resultId: 'external-change',
      attemptId: 'external-1',
      inputRevision: 'commit-1',
      inputHash: hash('b'),
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
      completedAt: 3,
    });
    expect(reviews.finalize('workflow-1')).toMatchObject({
      kind: 'decision_required',
      code: 'stale_review',
    });
    expect(() =>
      reviews.recordEvidence(
        'workflow-1',
        {
          version: 1,
          evidenceId: 'stale',
          resultId: 'implementation-1',
          criterion: 'Criterion A',
          verdict: 'verified',
          artifactRevision: 'commit-1',
          evidenceRefs: ['old-test'],
          checkedAt: 4,
        },
        hash('b'),
        'host',
      ),
    ).toThrow(/stale|artifact/i);
  });

  it('makes failed, exhausted, and unknown-cost reviews explicit decisions', () => {
    reviews.create(create({ limits: { maxReviewRounds: 1, maxTokens: 100, maxCostUsd: 0.2 } }));
    const result = recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [finding],
      resolvedFingerprints: [],
      usage: usage('reviewer-1', 50, 0.1),
    });
    expect(result.status).toBe('decision_required');
    expect(reviews.finalize('workflow-1')).toMatchObject({
      kind: 'decision_required',
      code: 'rounds_exhausted',
    });
    expect(() =>
      recordReview({
        workflowId: 'workflow-1',
        reviewId: 'review-2',
        reviewerSeatId: 'reviewer',
        kind: 'full',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        findings: [],
        resolvedFingerprints: [],
        usage: usage('reviewer-2'),
      }),
    ).toThrow(/round|exhaust/i);

    reviews.create(create({ workflowId: 'workflow-unknown-cost' }));
    expect(
      reviews.admitAttempt({
        workflowId: 'workflow-unknown-cost',
        attemptId: 'reviewer-unknown',
        enforcementId: 'cap-reviewer-unknown',
        kind: 'review',
        actorSeatId: 'reviewer',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        maxTokens: 50,
        maxCostUsd: null,
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'unknown_cost' });
    expect(reviews.finalize('workflow-unknown-cost')).toMatchObject({
      kind: 'decision_required',
      code: 'unknown_cost',
    });

    reviews.create(create({ workflowId: 'workflow-failed' }));
    expect(
      recordReview({
        workflowId: 'workflow-failed',
        reviewId: 'review-failed',
        reviewerSeatId: 'reviewer',
        kind: 'full',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        findings: [],
        resolvedFingerprints: [],
        usage: usage('reviewer-failed'),
        failure: 'reviewer unavailable',
      }),
    ).toMatchObject({ status: 'decision_required' });
    expect(reviews.finalize('workflow-failed')).toMatchObject({
      kind: 'decision_required',
      code: 'review_failed',
    });
  });

  it('keeps review retries idempotent after state changes and refuses conflicting reuse', () => {
    reviews.create(create());
    const input = {
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full' as const,
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [finding],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    };
    recordReview(input);
    expect(recordReview(input)).toMatchObject({ reviewRounds: 1, tokensUsed: 50 });
    expect(() => recordReview({ ...input, findings: [] })).toThrow(/idempotency/i);
  });

  it('requires owner-controlled authority covering every open finding and audits dismissal', () => {
    reviews.create(create());
    const second = {
      ...finding,
      summary: 'Missing timeout branch',
      location: 'server/feature.ts:20',
    };
    const state = recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [finding, second],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    const [firstKey, secondKey] = state.findings.map((item) => item.fingerprint);
    const auth = {
      workflowId: 'workflow-1',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      actor: 'intruder',
      authorityGrantId: 'grant-1',
      authorityRevision: 1,
      findingFingerprints: [firstKey],
      reason: 'Fix finding',
    };
    expect(() => reviews.authorizeFix(auth)).toThrow(/owner|authority/i);
    reviews.authorizeFix({ ...auth, actor: 'owner' });
    const fix = {
      ...implementation,
      resultId: 'fix-1',
      attemptId: 'implementer-2',
      inputRevision: 'commit-1',
      inputHash: hash('b'),
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
      completedAt: 2,
    };
    expect(() =>
      recordFix({
        workflowId: 'workflow-1',
        result: fix,
        implementerSeatId: 'coder',
        usage: usage('implementer-2'),
      }),
    ).toThrow(/authority|finding/i);
    reviews.dismissFinding({
      workflowId: 'workflow-1',
      fingerprint: secondKey,
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      actor: 'owner',
      reason: 'Explicitly out of scope',
      evidenceRefs: ['scope-decision:1'],
    });
    expect(
      reviews.get('workflow-1')?.findings.find((item) => item.fingerprint === secondKey),
    ).toMatchObject({ status: 'dismissed', disposition: { actor: 'owner' } });
    expect(
      recordFix({
        workflowId: 'workflow-1',
        result: fix,
        implementerSeatId: 'coder',
        usage: usage('implementer-2'),
      }),
    ).toMatchObject({
      status: 'awaiting_delta_review',
    });
  });

  it('stops at token and cost caps without double-counting an attempt', () => {
    reviews.create(create({ limits: { maxReviewRounds: 3, maxTokens: 40, maxCostUsd: 1 } }));
    const input = {
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full' as const,
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-1', 50, 0.1),
    };
    expect(recordReview(input)).toMatchObject({
      status: 'decision_required',
      decisionCode: 'token_budget_exhausted',
      tokensUsed: 50,
    });
    expect(recordReview(input)).toMatchObject({ tokensUsed: 50, reviewRounds: 1 });
    reviews.create(
      create({
        workflowId: 'cost',
        limits: {
          maxReviewRounds: 3,
          maxTokens: 100,
          maxCostUsd: 0.05,
        },
      }),
    );
    expect(recordReview({ ...input, workflowId: 'cost', usage: usage('cost-1') })).toMatchObject({
      decisionCode: 'cost_budget_exhausted',
    });
  });

  it('persists an ordered audit trail across reopening without duplicating a verified decision', () => {
    reviews.create(create());
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    reviews.recordEvidence(
      'workflow-1',
      {
        version: 1,
        evidenceId: 'host-1',
        resultId: 'implementation-1',
        criterion: 'Criterion A',
        verdict: 'verified',
        artifactRevision: 'commit-1',
        evidenceRefs: ['test-run:1'],
        checkedAt: 2,
      },
      hash('b'),
      'host',
    );
    expect(reviews.finalize('workflow-1').kind).toBe('verified');
    reviews.close();
    reviews = new SymposiumReviewStore(join(directory, 'events.db'));
    expect(reviews.finalize('workflow-1').kind).toBe('verified');
    expect(reviews.history('workflow-1').map((event) => event.action)).toEqual([
      'created',
      'attempt_admitted',
      'review_recorded',
      'evidence_recorded',
      'verified',
    ]);
  });

  it('does not clear an exhausted-budget decision when the artifact changes', () => {
    reviews.create(create({ limits: { maxReviewRounds: 2, maxTokens: 40, maxCostUsd: 1 } }));
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-1', 50, 0.1),
    });
    const changed = reviews.advanceArtifact('workflow-1', {
      ...implementation,
      resultId: 'external-change',
      attemptId: 'external-1',
      inputRevision: 'commit-1',
      inputHash: hash('b'),
      artifactRevision: 'commit-2',
      artifactHash: hash('c'),
      completedAt: 3,
    });
    expect(changed).toMatchObject({
      status: 'decision_required',
      decisionCode: 'token_budget_exhausted',
    });
    expect(reviews.finalize('workflow-1')).toMatchObject({
      kind: 'decision_required',
      code: 'token_budget_exhausted',
    });
  });

  it('refuses pre-dispatch review admission at an exact exhausted budget', () => {
    reviews.create(create({ limits: { maxReviewRounds: 2, maxTokens: 50, maxCostUsd: 1 } }));
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-1', 50, 0.1),
    });
    expect(
      reviews.admitAttempt({
        workflowId: 'workflow-1',
        attemptId: 'reviewer-2',
        enforcementId: 'cap-reviewer-2',
        kind: 'review',
        actorSeatId: 'reviewer',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        maxTokens: 1,
        maxCostUsd: 0.01,
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'token_budget_exhausted' });
  });

  it('persists an idempotent reservation and refuses a second in-flight dispatch', () => {
    reviews.create(create({ limits: { maxReviewRounds: 2, maxTokens: 50, maxCostUsd: 1 } }));
    const request = {
      workflowId: 'workflow-1',
      attemptId: 'reviewer-1',
      kind: 'review' as const,
      enforcementId: 'cap-reviewer-1',
      actorSeatId: 'reviewer',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      maxTokens: 40,
      maxCostUsd: 0.5,
    };
    expect(reviews.admitAttempt(request)).toMatchObject({ kind: 'admitted' });
    reviews.close();
    reviews = new SymposiumReviewStore(join(directory, 'events.db'));
    expect(reviews.admitAttempt(request)).toMatchObject({ kind: 'already_admitted' });
    expect(reviews.admitAttempt({ ...request, attemptId: 'reviewer-2' })).toMatchObject({
      kind: 'decision_required',
      code: 'attempt_in_progress',
    });
    expect(() => reviews.admitAttempt({ ...request, maxTokens: 20 })).toThrow(/idempotency/i);
    expect(reviews.get('workflow-1')).toMatchObject({ status: 'awaiting_review' });
  });

  it('does not let older host verification defeat newer current-artifact failure', () => {
    reviews.create(create());
    recordReview({
      workflowId: 'workflow-1',
      reviewId: 'review-1',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      findings: [],
      resolvedFingerprints: [],
      usage: usage('reviewer-1'),
    });
    const evidence = {
      version: 1 as const,
      resultId: 'implementation-1',
      criterion: 'Criterion A',
      artifactRevision: 'commit-1',
      evidenceRefs: ['test-run:1'],
    };
    reviews.recordEvidence(
      'workflow-1',
      { ...evidence, evidenceId: 'pass', verdict: 'verified', checkedAt: 2 },
      hash('b'),
      'host',
    );
    reviews.recordEvidence(
      'workflow-1',
      { ...evidence, evidenceId: 'fail', verdict: 'failed', checkedAt: 1 },
      hash('b'),
      'host',
    );
    expect(reviews.finalize('workflow-1')).toMatchObject({
      kind: 'decision_required',
      code: 'missing_evidence',
    });
  });
});
