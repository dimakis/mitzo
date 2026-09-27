import { afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore, type ApplicationAttempt } from '../symposium-review-workflows.js';
const stores: SymposiumReviewStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const store = (path = ':memory:') => {
  const s = new SymposiumReviewStore(path);
  stores.push(s);
  return s;
};
const hash = 'a'.repeat(64);
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
const input = () => ({
  workflowId: 'w',
  owner: 'user',
  sessionId: 's',
  initialArtifact: { revision: 'input', hash },
  implementer: selection('coder', 'coder'),
  reviewer: selection('reviewer', 'reviewer'),
  acceptanceCriteria: ['works'],
  limits: {
    version: 1 as const,
    mode: 'application' as const,
    maxHostTurns: 4,
    maxReviewCycles: 1,
    deadlineAt: Date.now() + 60000,
    noProgressLimit: 1,
  },
});
const initial = (attemptId = 'initial'): ApplicationAttempt => ({
  workflowId: 'w',
  attemptId,
  policyReservationId: attemptId,
  kind: 'initial',
  actorSeatId: 'coder',
  artifactRevision: 'input',
  artifactHash: hash,
  binding: {
    claimToken: attemptId,
    deliveryId: attemptId,
    contentHash: hash,
    membershipGeneration: 1,
    configRevision: 1,
    accountId: 'coder',
    model: 'offline',
    profileId: 'coder',
    profileRevision: '1',
    accountProfileRevision: '1',
    authorityGrant: { grantId: 'g', revision: 1 },
    contextGrant: { grantId: 'c', revision: 1 },
  },
});
const result = {
  version: 1 as const,
  resultId: 'result',
  attemptId: 'initial',
  inputRevision: 'input',
  inputHash: hash,
  artifactRevision: 'output',
  artifactHash: 'b'.repeat(64),
  summary: 'Implemented',
  evidenceRefs: ['artifact'],
  completedAt: 1,
};
const completion = () => ({
  workflowId: 'w',
  result,
  implementerSeatId: 'coder',
  policyReservationId: 'initial',
  operationId: 'op',
  usage: { attemptId: 'initial', tokens: null, costUsd: null },
});
function terminal(s: SymposiumReviewStore) {
  s.reserveApplicationAttempt(initial());
  s.consumeApplicationDispatch(initial());
  s.bindApplicationOperation('w', 'initial', 'op');
  s.settleApplicationExecution('w', 'initial', 'op', 'completed');
}
it('persists true preinitial state and refuses review, fix and artifact advancement before implementation', () => {
  const s = store();
  const state = s.createApplicationRun(input());
  expect(state).toMatchObject({
    implementation: null,
    currentResultId: null,
    status: 'awaiting_initial',
    hostTurns: 0,
    reviewCycles: 0,
    artifactRevision: 'input',
  });
  expect(() =>
    s.reserveApplicationAttempt({
      ...initial('review'),
      kind: 'review',
      actorSeatId: 'reviewer',
      binding: { ...initial('review').binding, accountId: 'reviewer', profileId: 'reviewer' },
    }),
  ).toThrow(/Review is not due/);
  expect(() => s.reserveApplicationAttempt({ ...initial('fix'), kind: 'fix' })).toThrow(
    /Fix is not due/,
  );
  expect(() => s.advanceArtifact('w', result)).toThrow(/initial/i);
  expect(s.get('w')?.hostTurns).toBe(0);
});
it('keeps terminal initial charged and unresolved across restart until exact semantic completion; preserves stop and unknown usage', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'preinitial-')), 'db');
  const a = store(path);
  a.createApplicationRun(input());
  terminal(a);
  const b = store(path);
  expect(b.get('w')?.applicationAttempts[0]).toMatchObject({
    terminalOutcome: 'completed',
    settled: false,
  });
  b.stopApplication('w', 'user', 'user_stop');
  const state = b.recordInitialResult(completion());
  expect(state).toMatchObject({
    implementation: result,
    currentResultId: 'result',
    status: 'decision_required',
    decisionCode: 'user_stop',
    policyResumeStatus: 'awaiting_review',
    hostTurns: 1,
    reviewCycles: 0,
    artifactRevision: 'output',
    usageCompleteness: { tokens: 'partial', cost: 'partial' },
  });
  expect(state.applicationAttempts[0].settled).toBe(true);
  expect(b.recordInitialResult(completion())).toEqual(state);
  expect(() =>
    b.recordInitialResult({ ...completion(), result: { ...result, summary: 'different' } }),
  ).toThrow(/conflict/i);
  b.continueApplication({
    workflowId: 'w',
    actor: 'user',
    authorizationId: 'fresh',
    reason: 'Continue',
    limits: input().limits,
  });
  expect(b.get('w')?.status).toBe('awaiting_review');
  expect(() =>
    b.reserveApplicationAttempt({
      ...initial('again'),
      artifactRevision: 'output',
      artifactHash: 'b'.repeat(64),
    }),
  ).toThrow(/Initial dispatch is not due/);
});
it('requires exact dispatched terminal operation, selected writer, reservation and original artifact', () => {
  const s = store();
  s.createApplicationRun(input());
  expect(() => s.recordInitialResult(completion())).toThrow();
  s.reserveApplicationAttempt(initial());
  s.consumeApplicationDispatch(initial());
  s.bindApplicationOperation('w', 'initial', 'op');
  expect(() => s.recordInitialResult(completion())).toThrow();
  s.settleApplicationExecution('w', 'initial', 'op', 'completed');
  for (const patch of [
    { operationId: 'wrong' },
    { policyReservationId: 'wrong' },
    { implementerSeatId: 'reviewer' },
    { result: { ...result, inputHash: 'c'.repeat(64) } },
    { result: { ...result, attemptId: 'wrong' } },
  ])
    expect(() => s.recordInitialResult({ ...completion(), ...patch })).toThrow();
  expect(s.get('w')?.implementation).toBeNull();
  expect(s.recordInitialResult(completion()).status).toBe('awaiting_review');
});
it('allows an explicit retry of a reconciled failed initial without resetting counters', () => {
  const s = store();
  s.createApplicationRun(input());
  s.reserveApplicationAttempt(initial());
  s.consumeApplicationDispatch(initial());
  s.bindApplicationOperation('w', 'initial', 'op');
  s.settleApplicationExecution('w', 'initial', 'op', 'failed');
  const retry = {
    ...initial('retry'),
    kind: 'retry' as const,
    retryOfAttemptId: 'initial',
    retryAuthorizationId: 'fresh',
  };
  expect(s.reserveApplicationAttempt(retry).kind).toBe('admitted');
  s.consumeApplicationDispatch(retry);
  s.bindApplicationOperation('w', 'retry', 'op-retry');
  s.settleApplicationExecution('w', 'retry', 'op-retry', 'completed');
  expect(
    s.recordInitialResult({
      ...completion(),
      result: { ...result, attemptId: 'retry' },
      policyReservationId: 'retry',
      operationId: 'op-retry',
      usage: { attemptId: 'retry', tokens: null, costUsd: null },
    }),
  ).toMatchObject({ status: 'awaiting_review', hostTurns: 2, reviewCycles: 0 });
});

import express from 'express';
import request from 'supertest';
import { ExecutionPolicySchema } from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import {
  createSymposiumReviewRouter,
  type SymposiumInteractiveReviewHost,
} from '../symposium-review-routes.js';
function hostFixture(s: SymposiumReviewStore) {
  const accounts = new AccountProfiles([
    {
      id: 'coder',
      label: 'Coder',
      provider: 'anthropic-vertex',
      projectId: 'p',
      region: 'r',
      credentialRef: '/tmp/offline-only',
      models: [{ id: 'offline', label: 'Offline' }],
    },
    {
      id: 'reviewer',
      label: 'Reviewer',
      provider: 'anthropic-vertex',
      projectId: 'p',
      region: 'r',
      credentialRef: '/tmp/offline-only',
      models: [{ id: 'offline', label: 'Offline' }],
    },
  ]);
  const role = (name: 'coder' | 'reviewer') => ({
    seatId: name,
    selectionId: name,
    profileRevision: 1,
    policyInput: {
      policy: ExecutionPolicySchema.parse({
        version: 1,
        policyId: name,
        revision: 'p',
        role: name,
        profileBinding: { profileId: name, profileRevision: '1' },
        primary: { accountId: name, model: 'offline', reasoningEffort: null },
        alternatives: [],
        contextGrant: { grantId: 'c', revision: 1 },
        authorityGrant: { grantId: 'g', revision: 1 },
        requiredCapabilities: { tools: false, context: false, route: true },
        limits: {
          maxAttempts: 4,
          maxTokens: 100,
          maxCostUsd: null,
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
    },
  });
  let output: typeof result | null = null;
  const host: SymposiumInteractiveReviewHost = {
    initialArtifact: () => ({ revision: 'input', hash }),
    completedImplementation: () => {
      throw new Error('Must never fabricate implementation');
    },
    currentArtifact: () =>
      output
        ? { revision: output.artifactRevision, hash: output.artifactHash }
        : { revision: 'input', hash },
    selectRoles: () => ({ implementer: role('coder'), reviewer: role('reviewer') }),
    prepareAttempt: () => ({ kind: 'decision_required', code: 'native_caps_unavailable' }),
    prepareApplicationAttempt: ({ attemptId }) => initial(attemptId),
    receipt: (_ctx, attemptId) =>
      output
        ? {
            workflowId: 'w',
            attemptId,
            policyReservationId: attemptId,
            operationId: 'op',
            terminal: true,
            kind: 'initial',
            actorSeatId: 'coder',
            artifactRevision: 'input',
            artifactHash: hash,
            tokens: null,
            costUsd: null,
          }
        : null,
    initialResult: () => output,
    completedReview: () => null,
    authorizeFix: () => null,
    fixedArtifact: () => null,
    evidence: () => null,
    dispatch: async (_ctx, reservation) => {
      const attempt = reservation.applicationAttempt!;
      s.consumeApplicationDispatch(attempt);
      s.bindApplicationOperation('w', attempt.attemptId, 'op');
      s.settleApplicationExecution('w', attempt.attemptId, 'op', 'completed');
      output = { ...result, attemptId: attempt.attemptId };
    },
  };
  return {
    host,
    setResult: (value: typeof result | null) => {
      output = value;
    },
  };
}
it('starts through trusted host roles and original artifact, never completedImplementation; rejects cross-scope and changed creation bindings', () => {
  const s = store();
  const { host } = hostFixture(s);
  const c = new SymposiumReviewCoordinator(s, host);
  const ctx = { owner: 'user', sessionId: 's' };
  const start = {
    workflowId: 'w',
    acceptanceCriteria: ['works'],
    limits: input().limits,
    expectedArtifactRevision: 'input',
    expectedArtifactHash: hash,
  };
  expect(c.startApplicationRun(ctx, start)).toMatchObject({
    status: 'awaiting_initial',
    implementation: null,
    implementer: { accountId: 'coder' },
  });
  expect(c.startApplicationRun(ctx, start)).toMatchObject({ status: 'awaiting_initial' });
  expect(() => c.startApplicationRun({ ...ctx, owner: 'other' }, start)).toThrow(/not found/);
  expect(() =>
    c.startApplicationRun(ctx, { ...start, expectedArtifactHash: 'b'.repeat(64) }),
  ).toThrow(/conflict/);
});
it('coordinator only records trusted initial output matching the current physical artifact', async () => {
  const s = store();
  s.createApplicationRun(input());
  const { host, setResult } = hostFixture(s);
  const c = new SymposiumReviewCoordinator(s, host);
  const ctx = { owner: 'user', sessionId: 's' };
  const reservation = c.reserve(ctx, 'w', 'initial', 'initial');
  expect(reservation.kind).toBe('reserved_not_dispatched');
  if (reservation.kind !== 'reserved_not_dispatched') throw new Error('reservation failed');
  expect(c.recordInitialResult(ctx, 'w', 'initial')).toMatchObject({
    code: 'host_initial_receipt_required',
  });
  await host.dispatch(ctx, reservation);
  const current = host.currentArtifact;
  host.currentArtifact = () => ({ revision: 'wrong', hash });
  expect(c.recordInitialResult(ctx, 'w', 'initial')).toMatchObject({
    code: 'host_initial_receipt_required',
  });
  host.currentArtifact = current;
  setResult({ ...result, inputHash: 'c'.repeat(64) });
  expect(c.recordInitialResult(ctx, 'w', 'initial')).toMatchObject({
    code: 'host_initial_receipt_required',
  });
  setResult(result);
  expect(c.recordInitialResult(ctx, 'w', 'initial')).toMatchObject({
    status: 'awaiting_review',
    implementation: result,
  });
});
it('exposes authenticated artifact-bound application start and initial action with no caller result authority', async () => {
  const s = store();
  const { host } = hostFixture(s);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization) res.locals.authSession = { id: 'signed-in' };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({ store: s, getHost: () => host, hasSession: (id) => id === 's' }),
  );
  const base = '/api/sessions/s/symposium/reviews';
  const start = {
    workflowId: 'w',
    acceptanceCriteria: ['works'],
    limits: input().limits,
    expectedArtifactRevision: 'input',
    expectedArtifactHash: hash,
  };
  expect(
    (
      await request(app)
        .post(base + '/application-runs')
        .send(start)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post(base + '/application-runs')
        .set('Authorization', 'test')
        .send({ ...start, implementation: result })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post(base + '/application-runs')
        .set('Authorization', 'test')
        .send({ ...start, expectedArtifactHash: 'c'.repeat(64) })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(app)
        .post(base + '/application-runs')
        .set('Authorization', 'test')
        .send(start)
    ).body.status,
  ).toBe('awaiting_initial');
  const action = {
    action: 'initial',
    expectedArtifactRevision: 'input',
    expectedArtifactHash: hash,
  };
  expect(
    (
      await request(app)
        .post(base + '/w/actions')
        .set('Authorization', 'test')
        .send({ ...action, expectedArtifactRevision: 'stale' })
    ).status,
  ).toBe(409);
  const completed = await request(app)
    .post(base + '/w/actions')
    .set('Authorization', 'test')
    .send(action);
  expect(completed.status).toBe(200);
  expect(completed.body.status).toBe('awaiting_review');
  expect(completed.body.hostTurns).toBe(1);
});

it('uses trusted application role pins without constructing a native budget policy for either application start path', () => {
  const s = store();
  const { host } = hostFixture(s);
  host.selectApplicationRoles = () => ({
    implementer: selection('coder', 'coder'),
    reviewer: selection('reviewer', 'reviewer'),
  });
  host.selectRoles = () => {
    throw new Error('Native token policy must not be invented');
  };
  const c = new SymposiumReviewCoordinator(s, host);
  expect(
    c.startApplicationRun(
      { owner: 'user', sessionId: 's' },
      {
        workflowId: 'w',
        acceptanceCriteria: ['works'],
        limits: input().limits,
        expectedArtifactRevision: 'input',
        expectedArtifactHash: hash,
      },
    ),
  ).toMatchObject({ status: 'awaiting_initial', implementation: null });
  host.completedImplementation = () => result;
  host.currentArtifact = () => ({ revision: result.artifactRevision, hash: result.artifactHash });
  expect(
    c.start(
      { owner: 'user', sessionId: 'other' },
      { workflowId: 'completed', acceptanceCriteria: ['works'], limits: input().limits },
    ),
  ).toMatchObject({ status: 'awaiting_review', implementation: result });
});

it('retains a lost-response initial operation for recovery without another dispatch', async () => {
  const s = store();
  const { host } = hostFixture(s);
  let dispatches = 0;
  const dispatch = host.dispatch;
  host.dispatch = async (ctx, reservation) => {
    dispatches++;
    await dispatch(ctx, reservation);
    throw new Error('response lost after terminal completion');
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'signed-in' };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({ store: s, getHost: () => host, hasSession: (id) => id === 's' }),
  );
  const base = '/api/sessions/s/symposium/reviews';
  await request(app)
    .post(base + '/application-runs')
    .send({
      workflowId: 'w',
      acceptanceCriteria: ['works'],
      limits: input().limits,
      expectedArtifactRevision: 'input',
      expectedArtifactHash: hash,
    });
  expect(
    (
      await request(app)
        .post(base + '/w/actions')
        .send({ action: 'initial', expectedArtifactRevision: 'input', expectedArtifactHash: hash })
    ).status,
  ).toBe(409);
  const pending = s.get('w')!.applicationAttempts[0];
  expect(pending).toMatchObject({ settled: false, terminalOutcome: 'completed' });
  expect(s.get('w')!.implementation).toBeNull();
  const recovered = await request(app)
    .post(base + '/w/actions')
    .send({
      action: 'recover',
      kind: 'initial',
      attemptId: pending.attemptId,
      expectedArtifactRevision: 'input',
      expectedArtifactHash: hash,
    });
  expect(recovered.status).toBe(200);
  expect(recovered.body.status).toBe('awaiting_review');
  expect(dispatches).toBe(1);
  expect(recovered.body.hostTurns).toBe(1);
});
it('can continue after a never-dispatched initial reservation is stopped without refunding it', () => {
  const s = store();
  s.createApplicationRun(input());
  s.reserveApplicationAttempt(initial());
  s.stopApplication('w', 'user', 'user_stop');
  s.continueApplication({
    workflowId: 'w',
    actor: 'user',
    authorizationId: 'fresh',
    reason: 'Continue',
    limits: input().limits,
  });
  expect(s.reserveApplicationAttempt(initial('next')).kind).toBe('admitted');
  expect(s.get('w')!.hostTurns).toBe(2);
});
