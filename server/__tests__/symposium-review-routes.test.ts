import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { createSymposiumReviewRouter } from '../symposium-review-routes.js';
const stores: SymposiumReviewStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture(owner?: string, host?: { criterionChecks(): unknown[] }) {
  const store = new SymposiumReviewStore(':memory:');
  stores.push(store);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (owner) res.locals.authSession = { id: owner };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({
      store,
      getHost: () => (host as never) ?? null,
      hasSession: (id) => id === 'session',
    }),
  );
  return { app, store };
}
it('requires an interactive identity even when an internal caller reaches the router', async () => {
  expect((await request(fixture().app).get('/api/sessions/session/symposium/reviews')).status).toBe(
    403,
  );
});
it('reports missing native review authority without creating a workflow or dispatching', async () => {
  const { app } = fixture('owner');
  const response = await request(app)
    .post('/api/sessions/session/symposium/reviews')
    .send({
      workflowId: 'workflow',
      acceptanceCriteria: ['criterion'],
      limits: { maxReviewRounds: 2, maxTokens: 100, maxCostUsd: null },
    });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('trusted_review_host_unavailable');
  expect((await request(app).get('/api/sessions/session/symposium/reviews')).body).toEqual({
    available: false,
    stopAvailable: false,
    applicationRun: {
      available: false,
      initialArtifact: null,
      reason: 'Trusted initial artifact unavailable',
    },
    workflows: [],
    criterionChecks: [],
  });
});
it('discovers only host-registered checks through the authenticated review route', async () => {
  const host = {
    criterionChecks: () => [
      { id: 'marker', criterion: 'Marker exists', kind: 'file-sha256', path: 'marker.txt' },
    ],
  };
  expect(
    (await request(fixture(undefined, host).app).get('/api/sessions/session/symposium/reviews'))
      .status,
  ).toBe(403);
  const response = await request(fixture('owner', host).app).get(
    '/api/sessions/session/symposium/reviews',
  );
  expect(response.status).toBe(200);
  expect(response.body.criterionChecks).toEqual(host.criterionChecks());
});
it('rejects caller fabricated findings and owner identities', async () => {
  const { app } = fixture('owner');
  expect(
    (
      await request(app)
        .post('/api/sessions/session/symposium/reviews')
        .send({ owner: 'victim', findings: [] })
    ).status,
  ).toBe(400);
  expect((await request(app).get('/api/sessions/other/symposium/reviews')).status).toBe(404);
});

it('rejects actions without the artifact the user actually inspected', async () => {
  const { app } = fixture('owner');
  expect(
    (
      await request(app)
        .post('/api/sessions/session/symposium/reviews/flow/actions')
        .send({ action: 'review' })
    ).status,
  ).toBe(400);
});

it('recovers one retained charged preparation by its exact attempt ID', async () => {
  const store = new SymposiumReviewStore(':memory:');
  stores.push(store);
  const hash = 'a'.repeat(64);
  const selection = (seatId: string, role: string) => ({
    seatId,
    role,
    selectionId: seatId,
    policyRevision: 'config-1',
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
      evidenceRefs: ['commit'],
      completedAt: 1,
    },
    implementer: selection('coder', 'coder'),
    reviewer: selection('reviewer', 'reviewer'),
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
  const preparation = {
    workflowId: 'workflow',
    attemptId: 'retained-attempt',
    policyReservationId: 'policy',
    kind: 'review' as const,
    actorSeatId: 'reviewer',
    artifactRevision: 'commit',
    artifactHash: hash,
    transitionId: 'reader',
    seal: {
      fenceId: 'fence',
      artifactGenerationId: 'generation',
      volumeName: 'volume',
      sealDigest: hash,
      artifactRevision: 'commit',
      artifactHash: hash,
    },
    from: { configRevision: 1, membershipGeneration: 1 },
    to: { configRevision: 2, membershipGeneration: 2 },
    expectedSelection: {
      accountId: 'reviewer',
      model: 'offline',
      profileId: 'reviewer',
      profileRevision: '1',
      accountProfileRevision: '1',
    },
  };
  store.reserveApplicationPreparation(preparation);
  const attempt = {
    workflowId: 'workflow',
    attemptId: 'retained-attempt',
    policyReservationId: 'policy',
    kind: 'review' as const,
    actorSeatId: 'reviewer',
    artifactRevision: 'commit',
    artifactHash: hash,
    binding: {
      claimToken: 'claim',
      contentHash: hash,
      deliveryId: 'delivery',
      membershipGeneration: 2,
      configRevision: 2,
      accountId: 'reviewer',
      model: 'offline',
      profileId: 'reviewer',
      profileRevision: '1',
      accountProfileRevision: '1',
      authorityGrant: { grantId: 'authority', revision: 1 },
      contextGrant: { grantId: 'context', revision: 1 },
    },
  };
  const dispatch = vi.fn(async () => {
    if (dispatch.mock.calls.length === 1) throw new Error('simulated crash before native dispatch');
    expect(store.consumeApplicationDispatch(attempt)).toMatchObject({
      kind: 'dispatch_authorized',
    });
  });
  const host = {
    currentArtifact: () => ({ revision: 'commit', hash }),
    refreshArtifact: async () => {},
    prepareApplicationTransition: vi.fn(async () => preparation),
    completeApplicationTransition: vi.fn(async () => ({
      attempt,
      proof: { transitionId: 'reader', sealDigest: hash },
    })),
    dispatch,
    completedReview: () => null,
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'owner' };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({
      store,
      getHost: () => host as never,
      hasSession: () => true,
    }),
  );
  const recover = () =>
    request(app).post('/api/sessions/session/symposium/reviews/workflow/actions').send({
      action: 'recover',
      attemptId: 'retained-attempt',
      kind: 'review',
      expectedArtifactRevision: 'commit',
      expectedArtifactHash: hash,
    });
  const crashed = await recover();
  expect(crashed.body.error).toBe('simulated crash before native dispatch');
  expect(store.get('workflow')?.applicationAttempts[0]).toMatchObject({ dispatched: false });
  const response = await recover();
  expect(response.body).toMatchObject({
    code: 'host_review_result_required',
    attemptId: 'retained-attempt',
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(host.prepareApplicationTransition).toHaveBeenCalledWith(
    expect.objectContaining({ attemptId: 'retained-attempt' }),
  );
  expect(store.get('workflow')).toMatchObject({
    hostTurns: 1,
    applicationPreparations: [{ status: 'bound' }],
    applicationAttempts: [{ dispatched: true }],
  });
  const alreadyDispatched = await recover();
  expect(alreadyDispatched.body.code).toBe('host_review_result_required');
  expect(dispatch).toHaveBeenCalledTimes(2);
});
