import express from 'express';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import {
  createSymposiumReviewRouter,
  type SymposiumInteractiveReviewHost,
} from '../symposium-review-routes.js';
const hash = 'a'.repeat(64);
const stores: SymposiumReviewStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup(
  authorizeContext?: Parameters<typeof createSymposiumReviewRouter>[0]['authorizeContext'],
) {
  const store = new SymposiumReviewStore(':memory:');
  stores.push(store);
  let refreshed = false;
  const selection = (seatId: string, role: string) => ({
    seatId,
    role,
    selectionId: seatId,
    policyRevision: 'p',
    profileId: seatId,
    profileRevision: 1,
    accountId: seatId,
    model: 'offline',
  });
  const host: SymposiumInteractiveReviewHost = {
    refreshArtifact: vi.fn(async () => {
      refreshed = true;
    }),
    initialArtifact: () => {
      if (!refreshed) throw new Error('stale cache');
      return { revision: 'input', hash };
    },
    currentArtifact: () => {
      if (!refreshed) throw new Error('stale cache');
      return { revision: 'input', hash };
    },
    completedImplementation: () => {
      throw new Error('No implementation');
    },
    selectRoles: () => {
      throw new Error('No native policy');
    },
    selectApplicationRoles: () => ({
      implementer: selection('coder', 'coder'),
      reviewer: selection('reviewer', 'reviewer'),
    }),
    prepareAttempt: () => ({ kind: 'decision_required', code: 'unavailable' }),
    prepareApplicationAttempt: () => ({ kind: 'decision_required', code: 'offline_dispatch_only' }),
    receipt: () => null,
    completedReview: () => null,
    authorizeFix: () => null,
    fixedArtifact: () => null,
    evidence: () => null,
    cancelApplicationAttempts: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}),
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'authenticated' };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({
      store,
      authorizeContext,
      getHost: () => host,
      hasSession: (id) => id === 's',
    }),
  );
  const limits = {
    version: 1,
    mode: 'application',
    maxHostTurns: 4,
    maxReviewCycles: 1,
    deadlineAt: Date.now() + 60000,
    noProgressLimit: 1,
  };
  const start = {
    workflowId: 'w',
    acceptanceCriteria: ['works'],
    limits,
    expectedArtifactRevision: 'input',
    expectedArtifactHash: hash,
  };
  return { app, host, store, start, base: '/api/sessions/s/symposium/reviews' };
}
it('refreshes physical state before exposing trusted initial artifact and before start/action', async () => {
  const { app, host, start, base } = setup();
  const list = await request(app).get(base);
  expect(list.body.applicationRun).toEqual({
    available: true,
    initialArtifact: { revision: 'input', hash },
  });
  expect(host.refreshArtifact).toHaveBeenCalledTimes(1);
  expect(
    (
      await request(app)
        .post(base + '/application-runs')
        .send(start)
    ).status,
  ).toBe(200);
  expect(host.refreshArtifact).toHaveBeenCalledTimes(2);
  expect(
    (
      await request(app)
        .post(base + '/w/actions')
        .send({ action: 'initial', expectedArtifactRevision: 'input', expectedArtifactHash: hash })
    ).body.code,
  ).toBe('offline_dispatch_only');
  expect(host.refreshArtifact).toHaveBeenCalledTimes(3);
});
it('keeps history readable on refresh failure and fails closed before starting or acting, but permits stop', async () => {
  const { app, host, start, base, store } = setup();
  await request(app)
    .post(base + '/application-runs')
    .send(start);
  host.refreshArtifact = vi.fn(async () => {
    throw new Error('Physical verification unavailable');
  });
  const list = await request(app).get(base);
  expect(list.status).toBe(200);
  expect(list.body.available).toBe(false);
  expect(list.body.workflows).toHaveLength(1);
  expect(list.body.applicationRun).toMatchObject({ available: false, initialArtifact: null });
  expect(
    (
      await request(app)
        .post(base + '/application-runs')
        .send({ ...start, workflowId: 'new' })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(app)
        .post(base)
        .send({ workflowId: 'legacy', acceptanceCriteria: ['works'], limits: start.limits })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(app)
        .post(base + '/w/actions')
        .send({ action: 'initial', expectedArtifactRevision: 'input', expectedArtifactHash: hash })
    ).status,
  ).toBe(409);
  expect(store.get('w')!.hostTurns).toBe(0);
  expect(host.dispatch).not.toHaveBeenCalled();
  expect(
    (
      await request(app)
        .post(base + '/w/actions')
        .send({ action: 'stop', expectedArtifactRevision: 'input', expectedArtifactHash: hash })
    ).status,
  ).toBe(200);
  expect(store.get('w')!.decisionCode).toBe('user_stop');
});
it('does not advertise an unbound initial artifact', async () => {
  const { app, host, base } = setup();
  host.currentArtifact = () => ({ revision: 'changed', hash });
  expect((await request(app).get(base)).body.applicationRun).toMatchObject({
    available: false,
    initialArtifact: null,
  });
  host.initialArtifact = undefined;
  expect((await request(app).get(base)).body.applicationRun).toMatchObject({
    available: false,
    initialArtifact: null,
  });
});

it('issues one opaque context per authenticated request and never persists it as workflow data', async () => {
  const issued: object[] = [];
  const authorizeContext = vi.fn((_req, _res, ctx) => {
    const interactiveAuthorization = {};
    issued.push(interactiveAuthorization);
    return { ...ctx, interactiveAuthorization };
  });
  const { app, host, start, base, store } = setup(authorizeContext);
  const contexts: unknown[] = [];
  const initial = host.initialArtifact!;
  host.initialArtifact = (ctx) => {
    contexts.push(ctx.interactiveAuthorization);
    return initial(ctx);
  };
  const response = await request(app)
    .post(base + '/application-runs')
    .send(start);
  expect(response.status).toBe(200);
  expect(authorizeContext).toHaveBeenCalledTimes(1);
  expect(contexts[0]).toBe(issued[0]);
  expect(store.get('w')).not.toHaveProperty('interactiveAuthorization');
  expect(JSON.stringify(store.history('w'))).not.toContain('interactiveAuthorization');
});
it('rejects denied request authorization before refreshing or changing workflow state', async () => {
  const { app, host, start, base, store } = setup(() => {
    throw new Error('expired session');
  });
  expect(
    (
      await request(app)
        .post(base + '/application-runs')
        .send(start)
    ).status,
  ).toBe(403);
  expect(host.refreshArtifact).not.toHaveBeenCalled();
  expect(store.get('w')).toBeNull();
});

it('routes application review through the charged transition preparation', async () => {
  const { app, start, base } = setup();
  await request(app)
    .post(base + '/application-runs')
    .send(start);
  const reserve = vi
    .spyOn(SymposiumReviewCoordinator.prototype, 'reserveWithTransition')
    .mockResolvedValue({ kind: 'decision_required', code: 'transition_preparation_required' });
  try {
    const result = await request(app)
      .post(base + '/w/actions')
      .send({ action: 'review', expectedArtifactRevision: 'input', expectedArtifactHash: hash });
    expect(result.body.code).toBe('transition_preparation_required');
    expect(reserve).toHaveBeenCalledOnce();
  } finally {
    reserve.mockRestore();
  }
});
