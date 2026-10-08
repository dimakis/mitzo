/** Opt-in physical fixture driver. All lifecycle changes use the production HTTP
 * dispatcher/router; supplied callbacks only reopen/inspect the actual owners. */
import { expect } from 'vitest';
import type { EventStore } from '../event-store.js';
import type { SymposiumReviewStore } from '../symposium-review-workflows.js';
import type { SymposiumInteractiveReviewHost } from '../symposium-review-routes.js';
import type { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
import {
  createReviewRouteHarness,
  bindReviewRouteRequestAuthority,
} from './symposium-review-route-harness.js';

export async function runPhysicalApplicationRoutes(deps: {
  sessionId: string;
  events(): EventStore;
  store(): SymposiumReviewStore;
  host(): SymposiumInteractiveReviewHost;
  authority: SymposiumReviewActionAuthority;
  initialArtifact: { revision: string; hash: string };
  restartOwners(): void;
  jobs(): Array<{
    fence_id: string;
    phase: string;
    verifier_id: string | null;
    receipt_json: string | null;
  }>;
  dispatches(): number;
  runtimeCreations(): number;
  retainedRuntime(): object | null;
}) {
  const routes = createReviewRouteHarness({
    sessionId: deps.sessionId,
    store: deps.store,
    host: deps.host,
    hasSession: (id) => Boolean(deps.events().getSession(id)),
    authorize(req, res, context) {
      return bindReviewRouteRequestAuthority(req, res, context, deps.authority);
    },
  });
  const postAction = (body: Record<string, unknown>) => {
    const state = deps.store().get('workflow')!;
    return routes.post('/workflow/actions', {
      expectedArtifactRevision: state.artifactRevision,
      expectedArtifactHash: state.artifactHash,
      ...body,
    });
  };
  const status = (body: unknown) => (body as { status?: string }).status;
  const start = await routes.post('/application-runs', {
    workflowId: 'workflow',
    acceptanceCriteria: ['criterion.txt contains FIXED'],
    limits: {
      version: 1,
      mode: 'application',
      maxHostTurns: 12,
      maxReviewCycles: 2,
      deadlineAt: Date.now() + 900_000,
      noProgressLimit: 2,
    },
    expectedArtifactRevision: deps.initialArtifact.revision,
    expectedArtifactHash: deps.initialArtifact.hash,
  });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  expect(status(start.body)).toBe('awaiting_initial');
  const stopped = await postAction({ action: 'stop' });
  expect(stopped.status).toBe(200);
  expect(stopped.body).toMatchObject({ decisionCode: 'user_stop' });
  expect(deps.dispatches()).toBe(0);
  const continued = await postAction({
    action: 'continue',
    limits: deps.store().get('workflow')!.limits,
    reason: 'Resume route-owned run before the initial dispatch',
  });
  expect(continued.status, JSON.stringify(continued.body)).toBe(200);
  expect(status(continued.body)).toBe('awaiting_initial');

  const stale = await postAction({
    action: 'initial',
    expectedArtifactRevision: 'stale-source',
    expectedArtifactHash: '0'.repeat(64),
  });
  expect(stale).toMatchObject({ status: 409, body: { code: 'artifact_changed' } });
  expect(deps.dispatches()).toBe(0);
  const first = await postAction({ action: 'initial' });
  expect(first.status, JSON.stringify(first.body)).toBe(409);
  expect(first.body).toMatchObject({ error: 'Symposium seat cleanup incomplete' });
  const original = deps.store().get('workflow')!.applicationAttempts[0];
  expect(original.kind).toBe('initial');
  const originalSeal = deps.events().getSymposiumArtifactSealIntent(deps.sessionId)!;
  expect(deps.jobs()).toMatchObject([{ fence_id: originalSeal.fenceId, phase: 'draining' }]);
  deps.restartOwners();
  // Each known injected lost response is observed through the actual GET refresh.
  // This is bounded original-operation reconciliation, never a new action retry.
  for (const phase of ['draining', 'complete', 'complete']) {
    const refresh = await routes.get();
    expect(refresh.status).toBe(200);
    expect(refresh.body).toMatchObject({ available: false });
    expect(deps.jobs()).toMatchObject([{ fence_id: originalSeal.fenceId, phase }]);
    expect(deps.dispatches()).toBe(1);
    expect(deps.retainedRuntime()).toBeNull();
  }
  expect((await routes.get()).body).toMatchObject({ available: true });
  const recovered = await postAction({
    action: 'recover',
    attemptId: original.attemptId,
    kind: 'initial',
  });
  expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  expect(status(recovered.body)).toBe('awaiting_review');
  const afterOriginal = deps.store().get('workflow')!;
  const duplicate = await postAction({
    action: 'recover',
    attemptId: original.attemptId,
    kind: 'initial',
  });
  expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(200);
  expect(duplicate.body).toEqual(recovered.body);
  expect(deps.dispatches()).toBe(1);
  expect(deps.store().get('workflow')!.applicationAttempts).toEqual(
    afterOriginal.applicationAttempts,
  );

  const review = await postAction({ action: 'review' });
  expect(review.status, JSON.stringify(review.body)).toBe(409);
  expect(review.body).toMatchObject({ error: 'Symposium seat cleanup incomplete' });
  const reader = deps
    .store()
    .get('workflow')!
    .applicationAttempts.find((item) => item.kind === 'review')!;
  expect(reader).toBeDefined();
  expect(deps.dispatches()).toBe(2);
  const readerCreations = deps.runtimeCreations();
  expect((await routes.get()).body).toMatchObject({ available: false });
  expect(deps.retainedRuntime()).toBeNull();
  expect((await routes.get()).body).toMatchObject({ available: true });
  const readerRecovered = await postAction({
    action: 'recover',
    attemptId: reader.attemptId,
    kind: 'review',
  });
  expect(readerRecovered.status, JSON.stringify(readerRecovered.body)).toBe(200);
  expect(status(readerRecovered.body)).toBe('awaiting_fix');
  expect(deps.runtimeCreations()).toBe(readerCreations);
  const fix = await postAction({
    action: 'fix',
    findingFingerprints: deps
      .store()
      .get('workflow')!
      .findings.map((item) => item.fingerprint),
    reason: 'Correct the independently accepted marker finding',
  });
  expect(fix.status, JSON.stringify(fix.body)).toBe(200);
  expect(status(fix.body)).toBe('awaiting_delta_review');
  const staleDelta = await postAction({
    action: 'review',
    expectedArtifactRevision: deps.initialArtifact.revision,
  });
  expect(staleDelta).toMatchObject({ status: 409, body: { code: 'artifact_changed' } });
  expect(deps.dispatches()).toBe(3);
  const delta = await postAction({ action: 'review' });
  expect(delta.status, JSON.stringify(delta.body)).toBe(200);
  expect(status(delta.body)).toBe('awaiting_evidence');
  expect(
    deps
      .store()
      .get('workflow')!
      .applicationAttempts.map((item) => item.kind),
  ).toEqual(['initial', 'review', 'fix', 'delta']);
  const checked = await postAction({ action: 'check', definitionId: 'marker' });
  expect(checked.status, JSON.stringify(checked.body)).toBe(200);
  expect(status(checked.body)).toBe('awaiting_evidence');
  const checkedState = deps.store().get('workflow')!;
  const exactCheck = checkedState.evidence;
  expect(exactCheck).toHaveLength(1);
  const evidence = exactCheck[0];
  expect(evidence).toMatchObject({
    source: 'host',
    artifactHash: checkedState.artifactHash,
    item: {
      verdict: 'verified',
      resultId: checkedState.currentResultId,
      artifactRevision: checkedState.artifactRevision,
      criterion: 'criterion.txt contains FIXED',
    },
  });
  expect(evidence.item.evidenceRefs.length).toBeGreaterThan(0);
  expect(
    deps.host().evidence({ owner: 'user', sessionId: deps.sessionId }, evidence.item.evidenceId),
  ).toEqual(evidence.item);
  expect((await postAction({ action: 'check', definitionId: 'marker' })).status).toBe(200);
  expect(deps.store().get('workflow')!.evidence).toEqual(exactCheck);
  const exported = await postAction({ action: 'review-record' });
  expect(exported.status, JSON.stringify(exported.body)).toBe(200);
  expect(exported.body).toMatchObject({ kind: 'verified', publication: 'not_created' });
  expect(deps.store().get('workflow')!.status).toBe('verified');
  const recordId = (exported.body as { record: { recordId: string } }).record.recordId;
  const record = deps.store().getReviewRecord('user', deps.sessionId, recordId)!;
  expect(record).not.toBeNull();
  expect(await routes.get(`/records/${recordId}`)).toMatchObject({ status: 200, body: record });
  const preflight = await routes.post(`/records/${recordId}/publication-preflight`, {});
  expect(preflight).toEqual({
    status: 409,
    body: {
      kind: 'decision_required',
      code: 'review_publication_unavailable',
      publication: 'not_created',
    },
  });
  expect(deps.dispatches()).toBe(4);
  expect(deps.runtimeCreations()).toBe(4);
  return { record, originalSealFenceId: originalSeal.fenceId };
}
