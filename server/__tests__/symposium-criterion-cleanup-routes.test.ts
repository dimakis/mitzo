import {
  createReviewRouteHarness,
  bindReviewRouteRequestAuthority,
} from './symposium-review-route-harness.js';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
import type { ReviewContext } from '../symposium-review-coordinator.js';
import { afterEach, expect, it, vi } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import type { SymposiumInteractiveReviewHost } from '../symposium-review-routes.js';
const stores: SymposiumReviewStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function fixture() {
  const store = new SymposiumReviewStore(':memory:');
  stores.push(store);
  const hash = 'a'.repeat(64);
  const selection = (seatId: string, role: string) => ({
    seatId,
    role,
    selectionId: seatId,
    policyRevision: '1',
    profileId: seatId,
    profileRevision: 1,
    accountId: seatId,
    model: 'offline',
  });
  store.create({
    workflowId: 'workflow',
    owner: 'user',
    sessionId: 'session',
    implementation: {
      version: 1,
      resultId: 'result',
      attemptId: 'initial',
      inputRevision: 'source',
      inputHash: hash,
      artifactRevision: 'commit',
      artifactHash: hash,
      summary: 'ready',
      evidenceRefs: ['artifact-seal:original'],
      completedAt: 1,
    },
    implementer: selection('coder', 'coder'),
    reviewer: selection('reader', 'reviewer'),
    acceptanceCriteria: ['works'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 3,
      maxReviewCycles: 1,
      deadlineAt: Date.now() + 60000,
      noProgressLimit: 1,
    },
  });
  const refresh = vi.fn(async () => {
    throw Error('unfinished semantic helper');
  });
  const cleanup = vi.fn(async () => ({
    state: 'failed_cleaned',
    retryAllowed: false,
    semanticEvidenceAllowed: false,
  }));
  const host = {
    refreshArtifact: refresh,
    cleanupCriterionCheck: cleanup,
    criterionChecks: () => [],
  } as unknown as SymposiumInteractiveReviewHost;
  const authority = new SymposiumReviewActionAuthority();
  let captured: ReviewContext | undefined;
  const app = createReviewRouteHarness({
    sessionId: 'session',
    store: () => store,
    host: () => host,
    hasSession: () => true,
    authorize: (req, res, context) => {
      captured = context;
      return bindReviewRouteRequestAuthority(req, res, context, authority);
    },
  });
  const body = {
    action: 'cleanup-check',
    definitionId: 'registered',
    expectedArtifactRevision: 'commit',
    expectedArtifactHash: hash,
  };
  return { store, app, refresh, cleanup, body, authority, context: () => captured! };
}
it('reconciles only explicit original cleanup while ordinary refresh is blocked without recording evidence', async () => {
  const f = fixture();
  const before = f.store.get('workflow');
  const response = await f.app.post('/workflow/actions', f.body);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    state: 'failed_cleaned',
    retryAllowed: false,
    semanticEvidenceAllowed: false,
  });
  expect(f.refresh).not.toHaveBeenCalled();
  expect(f.cleanup).toHaveBeenCalledWith(
    { owner: 'user', sessionId: 'session' },
    'workflow',
    'registered',
  );
  expect(f.store.get('workflow')).toEqual(before);
});
it('refuses stale expected artifact without reaching cleanup', async () => {
  const f = fixture();
  const response = await f.app.post('/workflow/actions', {
    ...f.body,
    expectedArtifactHash: 'b'.repeat(64),
  });
  expect(response.status).toBe(409);
  expect(f.cleanup).not.toHaveBeenCalled();
});
it('refuses artifact changes during awaited cleanup rather than publishing its receipt', async () => {
  const f = fixture();
  f.cleanup.mockImplementationOnce(async () => ({
    state: 'failed_cleaned',
    retryAllowed: false,
    semanticEvidenceAllowed: false,
  }));
  // A changed persisted state is supplied via the real status owner on the second read.
  const get = f.store.get.bind(f.store);
  let reads = 0;
  vi.spyOn(f.store, 'get').mockImplementation((id) => {
    const state = get(id);
    return ++reads > 1 && state ? { ...state, artifactHash: 'b'.repeat(64) } : state;
  });
  const response = await f.app.post('/workflow/actions', f.body);
  expect(response.status).toBe(409);
});

it('releases captured cleanup capability after response and refuses late revoked requests', async () => {
  const f = fixture();
  f.cleanup.mockImplementationOnce(async () => {
    f.authority.assertCurrent(f.context(), 'cleanup-check');
    return { state: 'failed_cleaned', retryAllowed: false, semanticEvidenceAllowed: false };
  });
  await f.app.post('/workflow/actions', f.body);
  expect(() => f.authority.assertCurrent(f.context(), 'cleanup-check')).toThrow();
  f.cleanup.mockImplementationOnce(async () => {
    f.authority.assertCurrent(f.context(), 'cleanup-check');
    await Promise.resolve();
    f.app.revoke();
    f.authority.assertCurrent(f.context(), 'cleanup-check');
    return { state: 'failed_cleaned', retryAllowed: false, semanticEvidenceAllowed: false };
  });
  await expect(f.app.post('/workflow/actions', f.body)).rejects.toThrow(/expired|revoked/);
});
it('does not grant cleanup to an unauthenticated operator', async () => {
  const f = fixture();
  const response = await f.app.send(
    'POST',
    '/api/sessions/session/symposium/reviews/workflow/actions',
    f.body,
    false,
  );
  expect(response.status).toBe(403);
  expect(f.cleanup).not.toHaveBeenCalled();
});
