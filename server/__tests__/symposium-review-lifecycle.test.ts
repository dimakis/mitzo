import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import {
  createSymposiumReviewRouter,
  type SymposiumInteractiveReviewHost,
} from '../symposium-review-routes.js';
import type { CompletedReview, ReviewReceipt } from '../symposium-review-coordinator.js';
const stores: SymposiumReviewStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const store = new SymposiumReviewStore(':memory:');
  stores.push(store);
  const implementation = {
    version: 1 as const,
    resultId: 'result-1',
    attemptId: 'implementation',
    inputRevision: 'input',
    inputHash: 'a'.repeat(64),
    artifactRevision: 'commit-1',
    artifactHash: 'b'.repeat(64),
    summary: 'Ready',
    evidenceRefs: ['commit-1'],
    completedAt: 1,
  };
  let artifact = { revision: implementation.artifactRevision, hash: implementation.artifactHash };
  let receipt: ReviewReceipt | null = null;
  let review: CompletedReview | null = null;
  let fixed: typeof implementation | null = null;
  const selection = (seatId: string) => ({
    seatId,
    role: seatId === 'builder' ? 'coder' : 'reviewer',
    selectionId: seatId,
    policyRevision: 'policy',
    profileId: seatId,
    profileRevision: 1,
    accountId: seatId,
    model: 'mock-only',
  });
  store.create({
    workflowId: 'workflow',
    owner: 'operator:owner',
    sessionId: 'session',
    implementation,
    implementer: selection('builder'),
    reviewer: selection('reviewer'),
    acceptanceCriteria: ['works'],
    limits: { maxReviewRounds: 3, maxTokens: 1000, maxCostUsd: null },
  });
  const host: SymposiumInteractiveReviewHost = {
    completedImplementation: () => implementation,
    currentArtifact: () => artifact,
    selectRoles: () => {
      throw new Error('Not used');
    },
    prepareAttempt: ({ attemptId }) => ({
      kind: 'enforced',
      enforcementId: attemptId,
      maxTokens: 100,
      maxCostUsd: null,
    }),
    receipt: () => receipt,
    completedReview: () => review,
    fixedArtifact: () => fixed,
    authorizeFix: ({ context }) => ({
      actor: context.owner,
      authorityGrantId: 'write-grant',
      authorityRevision: 1,
    }),
    evidence: () => ({
      version: 1,
      evidenceId: 'check',
      resultId: 'result-2',
      criterion: 'works',
      verdict: 'verified',
      artifactRevision: artifact.revision,
      evidenceRefs: ['host:test-pass'],
      checkedAt: 2,
    }),
    dispatch: vi.fn(async (_context, reservation) => {
      receipt = {
        workflowId: 'workflow',
        attemptId: reservation.attemptId,
        enforcementId: reservation.enforcementId,
        terminal: true,
        kind: reservation.selection.seatId === 'reviewer' ? 'review' : 'fix',
        actorSeatId: reservation.selection.seatId,
        artifactRevision: reservation.artifactRevision,
        artifactHash: reservation.artifactHash,
        tokens: 50,
        costUsd: null,
      };
      if (receipt.kind === 'review')
        review = {
          workflowId: 'workflow',
          attemptId: reservation.attemptId,
          enforcementId: reservation.enforcementId,
          reviewId: reservation.attemptId,
          reviewerSeatId: 'reviewer',
          artifactRevision: artifact.revision,
          artifactHash: artifact.hash,
          kind: artifact.revision === 'commit-1' ? 'full' : 'delta',
          findings:
            artifact.revision === 'commit-1'
              ? [
                  {
                    criterion: 'works',
                    summary: 'Missing error branch',
                    location: 'app.ts:4',
                    evidenceRefs: ['diff:4'],
                  },
                ]
              : [],
          resolvedFingerprints:
            artifact.revision === 'commit-1'
              ? []
              : store.get('workflow')!.findings.map((f) => f.fingerprint),
        };
      else {
        fixed = {
          ...implementation,
          resultId: 'result-2',
          attemptId: reservation.attemptId,
          inputRevision: artifact.revision,
          inputHash: artifact.hash,
          artifactRevision: 'commit-2',
          artifactHash: 'c'.repeat(64),
        };
        artifact = { revision: fixed.artifactRevision, hash: fixed.artifactHash };
      }
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.authSession = { id: req.header('x-actor') || 'owner' };
    next();
  });
  app.use(
    '/sessions/:id/reviews',
    createSymposiumReviewRouter({
      store,
      getHost: () => host,
      hasSession: (id) => id === 'session',
    }),
  );
  const action = (body: Record<string, unknown>) =>
    request(app)
      .post('/sessions/session/reviews/workflow/actions')
      .send({
        expectedArtifactRevision: store.get('workflow')!.artifactRevision,
        expectedArtifactHash: store.get('workflow')!.artifactHash,
        ...body,
      });
  return { store, host, app, action };
}
it('runs explicit accepted fixes, requires delta and current host evidence before preparing a PR record', async () => {
  const { store, host, app, action } = fixture();
  expect((await action({ action: 'review' })).body.status).toBe('awaiting_fix');
  expect((await action({ action: 'review-record' })).body.code).toBe('open_findings');
  const fingerprint = store.get('workflow')!.findings[0].fingerprint;
  expect(
    (await action({ action: 'fix', findingFingerprints: [fingerprint], reason: 'Correctness' }))
      .body.status,
  ).toBe('awaiting_delta_review');
  expect((await action({ action: 'review-record' })).body.code).toBe('stale_review');
  expect((await action({ action: 'review' })).body.status).toBe('awaiting_evidence');
  expect((await action({ action: 'review-record' })).body.code).toBe('missing_evidence');
  expect((await action({ action: 'evidence', evidenceId: 'check' })).status).toBe(200);
  const record = await action({ action: 'review-record' });
  expect(record.body).toMatchObject({
    kind: 'verified',
    artifactRevision: 'commit-2',
    publication: 'not_created',
  });
  expect(record.body.history.map((entry: { action: string }) => entry.action)).toContain(
    'fix_authorized',
  );
  expect(host.dispatch).toHaveBeenCalledTimes(3);
  expect(
    (await request(app).get('/sessions/session/reviews').set('x-actor', 'other')).body.workflows,
  ).toEqual([]);
  expect(
    (await request(app).get('/sessions/session/reviews/workflow').set('x-actor', 'other')).status,
  ).toBe(404);
  expect((await action({ action: 'review', expectedArtifactRevision: 'commit-1' })).body.code).toBe(
    'artifact_changed',
  );
});
it('allows an explicit reasoned dismissal without granting the builder write access', async () => {
  const { store, host, action } = fixture();
  await action({ action: 'review' });
  const fingerprint = store.get('workflow')!.findings[0].fingerprint;
  const dismissed = await action({
    action: 'dismiss',
    fingerprint,
    reason: 'Already handled by caller',
    evidenceRefs: ['caller.ts:8'],
  });
  expect(dismissed.status).toBe(200);
  expect(store.get('workflow')!.findings[0]).toMatchObject({
    status: 'dismissed',
    disposition: { actor: 'operator:owner', reason: 'Already handled by caller' },
  });
  expect(host.dispatch).toHaveBeenCalledTimes(1);
});
