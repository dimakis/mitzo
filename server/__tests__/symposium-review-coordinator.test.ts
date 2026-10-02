import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import {
  SymposiumReviewCoordinator,
  type SymposiumReviewHost,
  type CompletedReview,
  type ReviewReceipt,
} from '../symposium-review-coordinator.js';

const hash = (letter: string) => letter.repeat(64);
const context = { owner: 'owner', sessionId: 'session' };
const implementation = {
  version: 1 as const,
  resultId: 'result-1',
  attemptId: 'implementation-1',
  inputRevision: 'input',
  inputHash: hash('a'),
  artifactRevision: 'commit-1',
  artifactHash: hash('b'),
  summary: 'Patch ready for review',
  evidenceRefs: ['commit-1'],
  completedAt: 1,
};
const receipt: ReviewReceipt = {
  attemptId: 'attempt-1',
  workflowId: 'workflow',
  enforcementId: 'host-cap-1',
  terminal: true,
  kind: 'review',
  actorSeatId: 'reviewer',
  artifactRevision: 'commit-1',
  artifactHash: hash('b'),
  tokens: 30,
  costUsd: 0.05,
};
const finding = {
  criterion: 'Criterion A',
  summary: 'Missing error branch',
  location: 'server/feature.ts:10',
  evidenceRefs: ['diff:10'],
};
const completedReview: CompletedReview = {
  workflowId: 'workflow',
  reviewId: 'review-1',
  attemptId: 'attempt-1',
  enforcementId: 'host-cap-1',
  reviewerSeatId: 'reviewer',
  artifactRevision: 'commit-1',
  artifactHash: hash('b'),
  kind: 'full',
  findings: [],
  resolvedFingerprints: [],
};
const selection = (seatId: string, role: string) => ({
  seatId,
  role,
  selectionId: `${seatId}-selection`,
  policyRevision: 'policy-1',
  profileId: role,
  profileRevision: 1,
  accountId: `${seatId}-account`,
  model: `${seatId}-model`,
});
let directory: string;
let store: SymposiumReviewStore;
let host: SymposiumReviewHost;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-review-coordinator-'));
  store = new SymposiumReviewStore(join(directory, 'events.db'));
  host = {
    completedImplementation: () => implementation,
    currentArtifact: () => ({ revision: 'commit-1', hash: hash('b') }),
    selectRoles: () => {
      throw new Error('Not used by direct-store fixtures');
    },
    prepareAttempt: () => ({
      kind: 'enforced',
      enforcementId: 'host-cap-1',
      maxTokens: 50,
      maxCostUsd: 0.1,
    }),
    receipt: () => null,
    completedReview: () => null,
    authorizeFix: () => null,
    fixedArtifact: () => null,
    evidence: () => null,
  };
  store.create({
    workflowId: 'workflow',
    ...context,
    implementation,
    implementer: selection('coder', 'coder'),
    reviewer: selection('reviewer', 'reviewer'),
    acceptanceCriteria: ['Criterion A'],
    limits: { maxReviewRounds: 2, maxTokens: 500, maxCostUsd: 1 },
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('scopes every workflow action to owner and same session and fails closed without a host', () => {
  const coordinator = new SymposiumReviewCoordinator(store, null);
  expect(() => coordinator.status({ owner: 'other', sessionId: 'session' }, 'workflow')).toThrow(
    /not found/i,
  );
  expect(() => coordinator.status({ owner: 'owner', sessionId: 'other' }, 'workflow')).toThrow(
    /not found/i,
  );
  expect(coordinator.reserve(context, 'workflow', 'review', 'attempt-1')).toEqual({
    kind: 'decision_required',
    code: 'trusted_review_host_unavailable',
  });
  expect(store.get('workflow')?.reservations).toEqual([]);
});

it('does not mistake an unenforced or unknown-price budget for native admission', () => {
  const unavailable = new SymposiumReviewCoordinator(store, {
    ...host,
    prepareAttempt: () => ({ kind: 'decision_required', code: 'native_limit_unavailable' }),
  });
  expect(unavailable.reserve(context, 'workflow', 'review', 'attempt-1')).toEqual({
    kind: 'decision_required',
    code: 'native_limit_unavailable',
  });
  const unknown = new SymposiumReviewCoordinator(store, {
    ...host,
    prepareAttempt: () => ({
      kind: 'enforced',
      enforcementId: 'host-cap',
      maxTokens: 50,
      maxCostUsd: null,
    }),
  });
  expect(unknown.reserve(context, 'workflow', 'review', 'attempt-1')).toEqual({
    kind: 'decision_required',
    code: 'unknown_cost',
  });
  expect(store.get('workflow')?.reservations).toEqual([]);
});

it('returns only a reservation, requires host receipt, and refuses model-only verification', () => {
  const coordinator = new SymposiumReviewCoordinator(store, host);
  expect(coordinator.reserve(context, 'workflow', 'review', 'attempt-1')).toMatchObject({
    kind: 'reserved_not_dispatched',
    attemptId: 'attempt-1',
    enforcementId: 'host-cap-1',
  });
  expect(coordinator.reserve(context, 'workflow', 'review', 'attempt-1')).toEqual({
    kind: 'decision_required',
    code: 'attempt_already_reserved',
  });
  const review = {
    workflowId: 'workflow',
    reviewId: 'review-1',
    attemptId: 'attempt-1',
    kind: 'full' as const,
    findings: [],
    resolvedFingerprints: [],
  };
  expect(coordinator.recordReview(context, review)).toEqual({
    kind: 'decision_required',
    code: 'host_receipt_required',
  });
  const mismatched = new SymposiumReviewCoordinator(store, {
    ...host,
    receipt: () => ({
      attemptId: 'other-attempt',
      workflowId: 'workflow',
      enforcementId: 'host-cap-1',
      terminal: true,
      kind: 'review',
      actorSeatId: 'reviewer',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      tokens: 30,
      costUsd: 0.05,
    }),
  });
  expect(mismatched.recordReview(context, review)).toEqual({
    kind: 'decision_required',
    code: 'host_receipt_required',
  });
  const wrongEnforcementHost: SymposiumReviewHost = {
    ...host,
    receipt: () => ({
      workflowId: 'workflow',
      attemptId: 'attempt-1',
      enforcementId: 'different-cap',
      terminal: true,
      kind: 'review',
      actorSeatId: 'reviewer',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      tokens: 30,
      costUsd: 0.05,
    }),
  };
  expect(
    new SymposiumReviewCoordinator(store, wrongEnforcementHost).recordReview(context, review),
  ).toEqual({
    kind: 'decision_required',
    code: 'host_receipt_required',
  });
  expect(store.get('workflow')?.reservations[0].enforcementId).toBe('host-cap-1');
  store.close();
  store = new SymposiumReviewStore(join(directory, 'events.db'));
  expect(
    new SymposiumReviewCoordinator(store, wrongEnforcementHost).recordReview(context, review),
  ).toEqual({
    kind: 'decision_required',
    code: 'host_receipt_required',
  });
  host = {
    ...host,
    receipt: () => ({
      attemptId: 'attempt-1',
      workflowId: 'workflow',
      enforcementId: 'host-cap-1',
      terminal: true,
      kind: 'review',
      actorSeatId: 'reviewer',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      tokens: 30,
      costUsd: 0.05,
    }),
  };
  host.completedReview = () => completedReview;
  const withReceipt = new SymposiumReviewCoordinator(store, host);
  expect(withReceipt.recordReview(context, review)).toMatchObject({ status: 'awaiting_evidence' });
  expect(withReceipt.finalize(context, 'workflow')).toEqual({
    kind: 'decision_required',
    code: 'missing_evidence',
  });
  expect(withReceipt.recordHostEvidence(context, 'workflow', 'model-claim')).toEqual({
    kind: 'decision_required',
    code: 'host_evidence_required',
  });
});

it('requires interactive owner authorization before a fix reservation', () => {
  host.completedReview = () => ({ ...completedReview, findings: [finding] });
  const review = new SymposiumReviewCoordinator(store, {
    ...host,
    receipt: () => ({
      attemptId: 'attempt-1',
      workflowId: 'workflow',
      enforcementId: 'host-cap-1',
      terminal: true,
      kind: 'review',
      actorSeatId: 'reviewer',
      artifactRevision: 'commit-1',
      artifactHash: hash('b'),
      tokens: 30,
      costUsd: 0.05,
    }),
  });
  review.reserve(context, 'workflow', 'review', 'attempt-1');
  review.recordReview(context, {
    workflowId: 'workflow',
    reviewId: 'review-1',
    attemptId: 'attempt-1',
  });
  const fingerprint = store.get('workflow')!.findings[0].fingerprint;
  expect(
    review.authorizeFix(context, {
      workflowId: 'workflow',
      findingFingerprints: [fingerprint],
      reason: 'Fix confirmed',
    }),
  ).toEqual({ kind: 'decision_required', code: 'interactive_fix_authority_required' });
  expect(() => review.reserve(context, 'workflow', 'fix', 'fix-1')).toThrow(/authority/i);
  const authorized = new SymposiumReviewCoordinator(store, {
    ...host,
    authorizeFix: () => ({ actor: 'owner', authorityGrantId: 'write-grant', authorityRevision: 1 }),
  });
  expect(
    authorized.authorizeFix(context, {
      workflowId: 'workflow',
      findingFingerprints: [fingerprint],
      reason: 'Fix confirmed',
    }),
  ).toMatchObject({ status: 'awaiting_fix' });
  expect(authorized.reserve(context, 'workflow', 'fix', 'fix-1')).toMatchObject({
    kind: 'reserved_not_dispatched',
    attemptId: 'fix-1',
  });
});

it('refuses caller-authored review content when no trusted result exists despite a valid receipt', () => {
  host.receipt = () => receipt;
  const coordinator = new SymposiumReviewCoordinator(store, host);
  coordinator.reserve(context, 'workflow', 'review', 'attempt-1');
  const fabricated = {
    workflowId: 'workflow',
    attemptId: 'attempt-1',
    reviewId: 'review-1',
    kind: 'full',
    findings: [],
    resolvedFingerprints: [],
  };
  expect(coordinator.recordReview(context, fabricated)).toEqual({
    kind: 'decision_required',
    code: 'host_review_result_required',
  });
  expect(store.get('workflow')).toMatchObject({
    status: 'awaiting_review',
    reviewRounds: 0,
    tokensUsed: 0,
  });
});

it('records only host findings and keeps replay identity bound to the completed output', () => {
  host.receipt = () => receipt;
  host.completedReview = () => ({ ...completedReview, findings: [finding] });
  const coordinator = new SymposiumReviewCoordinator(store, host);
  coordinator.reserve(context, 'workflow', 'review', 'attempt-1');
  const fabricated = {
    workflowId: 'workflow',
    attemptId: 'attempt-1',
    reviewId: 'review-1',
    kind: 'delta',
    findings: [],
    resolvedFingerprints: [hash('f')],
  };
  const state = coordinator.recordReview(context, fabricated);
  expect(state).toMatchObject({
    reviewRounds: 1,
    tokensUsed: 30,
    findings: [expect.objectContaining({ summary: finding.summary })],
  });
  expect(store.get('workflow')?.status).not.toBe('awaiting_evidence');
  const changedPayload = { ...fabricated, findings: [finding] };
  expect(coordinator.recordReview(context, changedPayload)).toEqual(state);
  expect(coordinator.recordReview(context, { ...fabricated, reviewId: 'invented' })).toEqual({
    kind: 'decision_required',
    code: 'host_review_result_required',
  });
});

it.each([
  ['workflowId', 'other'],
  ['attemptId', 'other'],
  ['enforcementId', 'other'],
  ['reviewerSeatId', 'coder'],
  ['artifactRevision', 'other'],
  ['artifactHash', hash('c')],
  ['reviewId', 'other'],
] as const)('rejects host output with mismatched %s', (field, value) => {
  host.receipt = () => receipt;
  host.completedReview = () => ({ ...completedReview, [field]: value });
  const coordinator = new SymposiumReviewCoordinator(store, host);
  coordinator.reserve(context, 'workflow', 'review', 'attempt-1');
  expect(
    coordinator.recordReview(context, {
      workflowId: 'workflow',
      attemptId: 'attempt-1',
      reviewId: 'review-1',
    }),
  ).toEqual({ kind: 'decision_required', code: 'host_review_result_required' });
  expect(store.get('workflow')).toMatchObject({
    status: 'awaiting_review',
    reviewRounds: 0,
    tokensUsed: 0,
  });
});

it('preserves a failed host review despite caller-forged success and on replay', () => {
  host.receipt = () => receipt;
  host.completedReview = () => ({
    ...completedReview,
    failure: 'Reviewer could not complete validation',
  });
  const coordinator = new SymposiumReviewCoordinator(store, host);
  coordinator.reserve(context, 'workflow', 'review', 'attempt-1');
  const forgedSuccess = {
    workflowId: 'workflow',
    attemptId: 'attempt-1',
    reviewId: 'review-1',
    kind: 'full',
    findings: [],
    resolvedFingerprints: [],
    failure: undefined,
  };
  const failed = coordinator.recordReview(context, forgedSuccess);
  expect(failed).toMatchObject({ status: 'decision_required', reviewRounds: 1, tokensUsed: 30 });
  expect(coordinator.recordReview(context, forgedSuccess)).toEqual(failed);
  expect(store.get('workflow')?.status).toBe('decision_required');
});
