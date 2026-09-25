import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';

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

describe('artifact-pinned Symposium review workflow', () => {
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

  it('deduplicates repeated findings, requires fix authority, and verifies only after delta and host evidence', () => {
    reviews.create(create());
    const first = reviews.recordReview({
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
      reviews.recordFix({
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
      reviews.recordFix({
        workflowId: 'workflow-1',
        result: fix,
        implementerSeatId: 'coder',
        usage: usage('implementer-2'),
      }),
    ).toMatchObject({
      artifactRevision: 'commit-2',
      status: 'awaiting_delta_review',
    });
    expect(() =>
      reviews.recordReview({
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
    reviews.recordReview({
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
    const result = reviews.recordReview({
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
      reviews.recordReview({
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
      reviews.recordReview({
        workflowId: 'workflow-unknown-cost',
        reviewId: 'review-unknown',
        reviewerSeatId: 'reviewer',
        kind: 'full',
        artifactRevision: 'commit-1',
        artifactHash: hash('b'),
        findings: [],
        resolvedFingerprints: [],
        usage: usage('reviewer-unknown', 50, null),
      }),
    ).toMatchObject({ status: 'decision_required' });
    expect(reviews.finalize('workflow-unknown-cost')).toMatchObject({
      kind: 'decision_required',
      code: 'unknown_cost',
    });

    reviews.create(create({ workflowId: 'workflow-failed' }));
    expect(
      reviews.recordReview({
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
    reviews.recordReview(input);
    expect(reviews.recordReview(input)).toMatchObject({ reviewRounds: 1, tokensUsed: 50 });
    expect(() => reviews.recordReview({ ...input, findings: [] })).toThrow(/idempotency/i);
  });

  it('requires owner-controlled authority covering every open finding and audits dismissal', () => {
    reviews.create(create());
    const second = {
      ...finding,
      summary: 'Missing timeout branch',
      location: 'server/feature.ts:20',
    };
    const state = reviews.recordReview({
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
      reviews.recordFix({
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
      reviews.recordFix({
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
    expect(reviews.recordReview(input)).toMatchObject({
      status: 'decision_required',
      decisionCode: 'token_budget_exhausted',
      tokensUsed: 50,
    });
    expect(reviews.recordReview(input)).toMatchObject({ tokensUsed: 50, reviewRounds: 1 });
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
    expect(
      reviews.recordReview({ ...input, workflowId: 'cost', usage: usage('cost-1') }),
    ).toMatchObject({ decisionCode: 'cost_budget_exhausted' });
  });

  it('persists an ordered audit trail across reopening without duplicating a verified decision', () => {
    reviews.create(create());
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
      'review_recorded',
      'evidence_recorded',
      'verified',
    ]);
  });
});
