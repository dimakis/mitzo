/** Real durable workflow/event owners, no native transport, admission or seal supplied.
 * These negative routes do not qualify a positive physical application lifecycle. */
import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import {
  createReviewRouteHarness,
  bindReviewRouteRequestAuthority,
} from './symposium-review-route-harness.js';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
import type { ReviewContext } from '../symposium-review-coordinator.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

function fixture() {
  const events = new EventStore(':memory:');
  const store = new SymposiumReviewStore(':memory:');
  cleanups.push(
    () => events.close(),
    () => store.close(),
  );
  events.upsertSession({ sessionId: 'session' });
  const host = vi.fn(() => null);
  const routes = createReviewRouteHarness({
    sessionId: 'session',
    store: () => store,
    host,
    hasSession: (id) => Boolean(events.getSession(id)),
  });
  return { events, store, routes, host };
}

function requestedWorkflow(store: SymposiumReviewStore) {
  const selection = (seatId: string, role: 'coder' | 'reviewer') => ({
    seatId,
    role,
    selectionId: seatId,
    policyRevision: 'request-only',
    profileId: seatId,
    profileRevision: 1,
    accountId: seatId,
    model: 'no-model',
  });
  // Workflow request metadata only: no WorkResult, claim, admission or physical seal.
  return store.createApplicationRun({
    workflowId: 'workflow',
    owner: 'user',
    sessionId: 'session',
    implementer: selection('coder', 'coder'),
    reviewer: selection('reviewer', 'reviewer'),
    initialArtifact: { revision: 'requested-source', hash: 'a'.repeat(64) },
    acceptanceCriteria: ['Not yet physically admitted'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 12,
      maxReviewCycles: 2,
      deadlineAt: Date.now() + 900_000,
      noProgressLimit: 2,
    },
  });
}

it.each(['initial', 'review', 'fix', 'recover', 'check', 'review-record'])(
  'rejects stale %s artifact through the real route before charging or preparing any actor',
  async (action) => {
    const { store, routes } = fixture();
    const before = requestedWorkflow(store);
    const response = await routes.post('/workflow/actions', {
      action,
      expectedArtifactRevision: 'stale-source',
      expectedArtifactHash: 'b'.repeat(64),
      ...(action === 'fix'
        ? { findingFingerprints: ['unaccepted'], reason: 'not authorized' }
        : {}),
      ...(action === 'recover' ? { attemptId: 'unknown', kind: 'initial' } : {}),
      ...(action === 'check' ? { definitionId: 'unknown' } : {}),
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ kind: 'decision_required', code: 'artifact_changed' });
    expect(store.get('workflow')).toEqual(before);
    expect(store.get('workflow')!.applicationAttempts).toEqual([]);
    expect(store.get('workflow')!.applicationPreparations).toEqual([]);
  },
);

it('never turns an exact original-ID request into native authority when the physical host is absent', async () => {
  const { store, routes } = fixture();
  const before = requestedWorkflow(store);
  const body = {
    action: 'recover',
    attemptId: 'original-request',
    kind: 'review',
    expectedArtifactRevision: before.artifactRevision,
    expectedArtifactHash: before.artifactHash,
  };
  for (let i = 0; i < 2; i++) {
    const response = await routes.post('/workflow/actions', body);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'trusted_review_host_unavailable' });
  }
  expect(store.get('workflow')).toEqual(before);
});

it('refuses caller-provided completion or claim receipts instead of creating review/delta authority', async () => {
  const { store, routes } = fixture();
  const before = requestedWorkflow(store);
  const response = await routes.post('/workflow/actions', {
    action: 'review',
    expectedArtifactRevision: before.artifactRevision,
    expectedArtifactHash: before.artifactHash,
    claimToken: 'caller-claim',
    seal: { fenceId: 'caller-seal' },
    completedReview: { findings: [] },
  });
  expect(response.status).toBe(400);
  expect(store.get('workflow')).toEqual(before);
});

it('requires hermetic interactive request authority and exact session before revealing workflow metadata', async () => {
  const { store, routes } = fixture();
  requestedWorkflow(store);
  expect(
    (await routes.send('GET', '/api/sessions/session/symposium/reviews', {}, false)).status,
  ).toBe(403);
  expect((await routes.send('GET', '/api/sessions/foreign/symposium/reviews')).status).toBe(404);
});

it('revokes the exact real action capability when the dispatcher has finished its response', async () => {
  const { store, events } = fixture();
  requestedWorkflow(store);
  const authority = new SymposiumReviewActionAuthority();
  let captured: ReviewContext | undefined;
  const routes = createReviewRouteHarness({
    sessionId: 'session',
    store: () => store,
    host: () => null,
    hasSession: (id) => Boolean(events.getSession(id)),
    authorize(req, res, context) {
      captured = context;
      return bindReviewRouteRequestAuthority(req, res, context, authority);
    },
  });
  const response = await routes.post('/workflow/actions', {
    action: 'fix',
    expectedArtifactRevision: 'stale-source',
    expectedArtifactHash: '0'.repeat(64),
    findingFingerprints: ['no-accepted-finding'],
    reason: 'Unadmitted request',
  });
  expect(response.status).toBe(409);
  expect(captured).toBeDefined();
  expect(authority.authorize(captured!, 'fix')).toBeNull();
});

it('rejects synthetic request revocation during the actual asynchronous route and retains no usable capability', async () => {
  const { store, events } = fixture();
  const before = requestedWorkflow(store);
  const authority = new SymposiumReviewActionAuthority();
  let captured: ReviewContext | undefined;
  const routes = createReviewRouteHarness({
    sessionId: 'session',
    store: () => store,
    host: () => null,
    hasSession: (id) => Boolean(events.getSession(id)),
    authorize(req, res, context) {
      captured = context;
      const bound = bindReviewRouteRequestAuthority(req, res, context, authority);
      queueMicrotask(() => routes.revoke());
      return bound;
    },
  });
  await expect(routes.get()).rejects.toThrow('Fixture request authority expired or revoked');
  expect(captured).toBeDefined();
  expect(authority.authorize(captured!, '')).toBeNull();
  expect(store.get('workflow')).toEqual(before);
});
