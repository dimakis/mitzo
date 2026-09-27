import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
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
const create = () => ({
  workflowId: 'w',
  owner: 'user',
  sessionId: 's',
  implementation: {
    version: 1 as const,
    resultId: 'r',
    attemptId: 'initial',
    inputRevision: 'i',
    inputHash: hash,
    artifactRevision: 'a',
    artifactHash: hash,
    summary: 'done',
    evidenceRefs: ['r'],
    completedAt: 1,
  },
  implementer: selection('coder', 'coder'),
  reviewer: selection('reviewer', 'reviewer'),
  acceptanceCriteria: ['works'],
  limits: {
    version: 1 as const,
    mode: 'application' as const,
    maxHostTurns: 2,
    maxReviewCycles: 1,
    deadlineAt: Date.now() + 60000,
    noProgressLimit: 1,
  },
});
const request = (attemptId: string) => ({
  workflowId: 'w',
  attemptId,
  policyReservationId: attemptId,
  kind: 'review' as const,
  actorSeatId: 'reviewer',
  artifactRevision: 'a',
  artifactHash: hash,
  binding: {
    claimToken: attemptId,
    contentHash: createHash('sha256').update('fixture').digest('hex'),
    deliveryId: attemptId,
    membershipGeneration: 1,
    configRevision: 1,
    accountId: 'reviewer',
    model: 'offline',
    profileId: 'reviewer',
    profileRevision: '1',
    accountProfileRevision: '1',
    authorityGrant: { grantId: 'g', revision: 1 },
    contextGrant: { grantId: 'c', revision: 1 },
  },
});
describe('persisted application admission', () => {
  it('charges once across connections/restart and consumes dispatch once', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'app-policy-')), 'db');
    const a = new SymposiumReviewStore(path);
    a.create(create());
    const b = new SymposiumReviewStore(path);
    expect(a.reserveApplicationAttempt(request('one')).kind).toBe('admitted');
    expect(b.reserveApplicationAttempt(request('two'))).toMatchObject({
      kind: 'decision_required',
      code: 'attempt_in_progress',
    });
    expect(a.consumeApplicationDispatch(request('one')).kind).toBe('dispatch_authorized');
    expect(b.consumeApplicationDispatch(request('one'))).toMatchObject({
      kind: 'decision_required',
      code: 'attempt_already_dispatched',
    });
    a.close();
    b.close();
    const c = new SymposiumReviewStore(path);
    expect(c.get('w')?.hostTurns).toBe(1);
    expect(c.reserveApplicationAttempt(request('two'))).toMatchObject({
      code: 'attempt_in_progress',
    });
    c.close();
  });
  it('durably stops admission and preserves unresolved claims on continuation', () => {
    const a = new SymposiumReviewStore(':memory:');
    a.create(create());
    a.reserveApplicationAttempt(request('one'));
    a.consumeApplicationDispatch(request('one'));
    a.stopApplication('w', 'user', 'user_stop');
    expect(a.consumeApplicationDispatch(request('one'))).toMatchObject({ code: 'user_stop' });
    expect(() =>
      a.continueApplication({
        workflowId: 'w',
        actor: 'user',
        authorizationId: 'fresh',
        reason: 'continue',
        limits: create().limits,
      }),
    ).toThrow(/unresolved/i);
    a.close();
  });
});

const terminalReview = (
  a: SymposiumReviewStore,
  id: string,
  findings: Array<{
    criterion: string;
    summary: string;
    location: string;
    evidenceRefs: string[];
  }> = [],
) => {
  a.consumeApplicationDispatch(request(id));
  a.bindApplicationOperation('w', id, 'op-' + id);
  a.settleApplicationExecution('w', id, 'op-' + id, 'completed');
  return a.recordReview({
    workflowId: 'w',
    reviewId: id,
    reviewerSeatId: 'reviewer',
    kind: 'full',
    artifactRevision: 'a',
    artifactHash: hash,
    findings,
    resolvedFingerprints: [],
    usage: { attemptId: id, tokens: null, costUsd: null },
  });
};
it('accepts trusted completion with unknown usage and preserves unknown observations', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  a.reserveApplicationAttempt(request('one'));
  const state = terminalReview(a, 'one');
  expect(state.status).toBe('awaiting_evidence');
  expect(state.attempts[0].tokens).toBeNull();
  a.close();
});
it('retains exact user fix intent without borrowing an old writer grant', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  a.reserveApplicationAttempt(request('one'));
  const state = terminalReview(a, 'one', [
    { criterion: 'works', summary: 'missing', location: 'file', evidenceRefs: ['diff'] },
  ]);
  const intent = {
    workflowId: 'w',
    artifactRevision: 'a',
    artifactHash: hash,
    actor: 'user',
    authorizationId: 'fresh-user-action',
    findingFingerprints: [state.findings[0].fingerprint],
    reason: 'fix selected finding',
  };
  expect(a.authorizeApplicationFixIntent(intent)).toMatchObject({ status: 'awaiting_fix' });
  expect(a.get('w')?.applicationFixIntents).toEqual([intent]);
  expect(a.get('w')?.authorizations).toEqual([]);
  expect(() => a.authorizeApplicationFixIntent({ ...intent, findingFingerprints: [hash] })).toThrow(
    /scope/i,
  );
  a.close();
});
it('refuses dispatch-only completion and conflicting terminal outcomes', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  a.reserveApplicationAttempt(request('one'));
  a.consumeApplicationDispatch(request('one'));
  expect(() =>
    a.recordReview({
      workflowId: 'w',
      reviewId: 'r',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'a',
      artifactHash: hash,
      findings: [],
      resolvedFingerprints: [],
      usage: { attemptId: 'one', tokens: null, costUsd: null },
    }),
  ).toThrow(/Dispatched/);
  a.bindApplicationOperation('w', 'one', 'op');
  a.settleApplicationExecution('w', 'one', 'op', 'cancelled');
  expect(() => a.settleApplicationExecution('w', 'one', 'op', 'completed')).toThrow(/conflict/);
  a.close();
});
it('fences expired final dispatch durably and never refunds its turn', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create({ ...create(), limits: { ...create().limits, deadlineAt: Date.now() + 10000 } });
  a.reserveApplicationAttempt(request('one'));
  const real = Date.now;
  Date.now = () => real() + 20000;
  try {
    expect(a.consumeApplicationDispatch(request('one'))).toMatchObject({
      code: 'deadline_exceeded',
    });
  } finally {
    Date.now = real;
  }
  expect(a.get('w')).toMatchObject({ hostTurns: 1, decisionCode: 'deadline_exceeded' });
  a.close();
});
it('prevents second policy owner and resolves strict claim projection', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  expect(() => a.create({ ...create(), workflowId: 'w2' })).toThrow(/already/);
  a.reserveApplicationAttempt(request('one'));
  expect(a.applicationAttemptForClaim('one')).toEqual(request('one'));
  expect(() => a.assertApplicationDispatch(a.applicationAttemptForClaim('one')!)).not.toThrow();
  a.close();
});
it('rejects retry without a reconciled original operation', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  expect(() =>
    a.reserveApplicationAttempt({
      ...request('retry'),
      kind: 'retry',
      actorSeatId: 'coder',
      binding: { ...request('retry').binding, accountId: 'coder', profileId: 'coder' },
    }),
  ).toThrow(/retry/i);
  a.close();
});
it('stops unchanged artifact/finding repetition without fabricating resolution', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create({ ...create(), limits: { ...create().limits, maxHostTurns: 8, maxReviewCycles: 2 } });
  a.reserveApplicationAttempt(request('one'));
  let state = terminalReview(a, 'one', [
    { criterion: 'works', summary: 'missing branch', location: 'file:1', evidenceRefs: ['diff'] },
  ]);
  a.authorizeFix({
    workflowId: 'w',
    artifactRevision: 'a',
    artifactHash: hash,
    actor: 'user',
    authorityGrantId: 'g',
    authorityRevision: 1,
    findingFingerprints: [state.findings[0].fingerprint],
    reason: 'fix',
  });
  const fix = {
    ...request('fix'),
    kind: 'fix' as const,
    actorSeatId: 'coder',
    binding: { ...request('fix').binding, accountId: 'coder', profileId: 'coder' },
  };
  expect(a.reserveApplicationAttempt(fix).kind).toBe('admitted');
  a.consumeApplicationDispatch(fix);
  a.bindApplicationOperation('w', 'fix', 'op-f');
  a.settleApplicationExecution('w', 'fix', 'op-f', 'completed');
  a.recordFix({
    workflowId: 'w',
    implementerSeatId: 'coder',
    usage: { attemptId: 'fix', tokens: null, costUsd: null },
    result: { ...create().implementation, attemptId: 'fix', inputRevision: 'a', inputHash: hash },
  });
  const delta = { ...request('delta'), kind: 'delta' as const };
  a.reserveApplicationAttempt(delta);
  a.consumeApplicationDispatch(delta);
  a.bindApplicationOperation('w', 'delta', 'op-d');
  a.settleApplicationExecution('w', 'delta', 'op-d', 'completed');
  state = a.recordReview({
    workflowId: 'w',
    reviewId: 'd',
    reviewerSeatId: 'reviewer',
    kind: 'delta',
    artifactRevision: 'a',
    artifactHash: hash,
    findings: [],
    resolvedFingerprints: [],
    usage: { attemptId: 'delta', tokens: null, costUsd: null },
  });
  expect(state).toMatchObject({ decisionCode: 'no_progress', hostTurns: 3, reviewCycles: 1 });
  expect(state.findings[0].status).toBe('open');
  a.close();
});
it('charges explicit reconciled retries and retains counters through authorized amendments', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create({ ...create(), limits: { ...create().limits, maxHostTurns: 1 } });
  a.reserveApplicationAttempt(request('one'));
  a.consumeApplicationDispatch(request('one'));
  a.bindApplicationOperation('w', 'one', 'op');
  a.settleApplicationExecution('w', 'one', 'op', 'failed');
  const retry = {
    ...request('retry'),
    kind: 'retry' as const,
    retryOfAttemptId: 'one',
    retryAuthorizationId: 'explicit-retry',
  };
  expect(a.reserveApplicationAttempt(retry)).toMatchObject({ code: 'host_turns_exhausted' });
  a.continueApplication({
    workflowId: 'w',
    actor: 'user',
    authorizationId: 'new-authority',
    reason: 'retry after reconciliation',
    limits: { ...create().limits, maxReviewCycles: 2 },
  });
  expect(a.reserveApplicationAttempt(retry).kind).toBe('admitted');
  expect(a.get('w')?.hostTurns).toBe(2);
  a.consumeApplicationDispatch(retry);
  a.bindApplicationOperation('w', 'retry', 'op-retry');
  a.settleApplicationExecution('w', 'retry', 'op-retry', 'completed');
  expect(
    a.recordReview({
      workflowId: 'w',
      reviewId: 'retry-result',
      reviewerSeatId: 'reviewer',
      kind: 'full',
      artifactRevision: 'a',
      artifactHash: hash,
      findings: [],
      resolvedFingerprints: [],
      usage: { attemptId: 'retry', tokens: null, costUsd: null },
    }).status,
  ).toBe('awaiting_evidence');
  expect(a.history('w').some((e) => e.action === 'application_continued')).toBe(true);
  a.close();
});

it('can continue safely after a stop before dispatch without refunding the reservation', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  a.reserveApplicationAttempt(request('one'));
  a.stopApplication('w', 'user', 'user_stop');
  expect(a.get('w')?.applicationAttempts[0].settled).toBe(true);
  a.continueApplication({
    workflowId: 'w',
    actor: 'user',
    authorizationId: 'amend',
    reason: 'resume',
    limits: create().limits,
  });
  expect(a.get('w')?.hostTurns).toBe(1);
  expect(a.consumeApplicationDispatch(request('one'))).toMatchObject({
    code: 'attempt_already_dispatched',
  });
  a.close();
});
it('does not use an amendment to rewind an active workflow phase', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  expect(() =>
    a.continueApplication({
      workflowId: 'w',
      actor: 'user',
      authorizationId: 'a',
      reason: 'amend',
      limits: create().limits,
    }),
  ).toThrow(/stopped/i);
  a.close();
});
it('blocks a third fix cycle while allowing the final delta turn', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create({ ...create(), limits: { ...create().limits, maxHostTurns: 12, maxReviewCycles: 2 } });
  a.reserveApplicationAttempt(request('one'));
  let state = terminalReview(a, 'one', [
    { criterion: 'works', summary: 'missing', location: 'file', evidenceRefs: ['diff'] },
  ]);
  for (let cycle = 1; cycle <= 2; cycle++) {
    const revision = state.artifactRevision,
      artifactHash = state.artifactHash;
    a.authorizeFix({
      workflowId: 'w',
      artifactRevision: revision,
      artifactHash,
      actor: 'user',
      authorityGrantId: 'g',
      authorityRevision: 1,
      findingFingerprints: [state.findings[0].fingerprint],
      reason: 'fix',
    });
    const fix = {
      ...request('fix' + cycle),
      kind: 'fix' as const,
      actorSeatId: 'coder',
      artifactRevision: revision,
      artifactHash,
      binding: { ...request('fix' + cycle).binding, accountId: 'coder', profileId: 'coder' },
    };
    expect(a.reserveApplicationAttempt(fix).kind).toBe('admitted');
    a.consumeApplicationDispatch(fix);
    a.bindApplicationOperation('w', fix.attemptId, 'op' + fix.attemptId);
    a.settleApplicationExecution('w', fix.attemptId, 'op' + fix.attemptId, 'completed');
    const nextHash = String(cycle).repeat(64);
    state = a.recordFix({
      workflowId: 'w',
      implementerSeatId: 'coder',
      usage: { attemptId: fix.attemptId, tokens: null, costUsd: null },
      result: {
        ...create().implementation,
        attemptId: fix.attemptId,
        inputRevision: revision,
        inputHash: artifactHash,
        artifactRevision: 'a' + cycle,
        artifactHash: nextHash,
      },
    });
    const delta = {
      ...request('delta' + cycle),
      kind: 'delta' as const,
      artifactRevision: state.artifactRevision,
      artifactHash: state.artifactHash,
    };
    expect(a.reserveApplicationAttempt(delta).kind).toBe('admitted');
    a.consumeApplicationDispatch(delta);
    a.bindApplicationOperation('w', delta.attemptId, 'op' + delta.attemptId);
    a.settleApplicationExecution('w', delta.attemptId, 'op' + delta.attemptId, 'completed');
    state = a.recordReview({
      workflowId: 'w',
      reviewId: delta.attemptId,
      reviewerSeatId: 'reviewer',
      kind: 'delta',
      artifactRevision: state.artifactRevision,
      artifactHash: state.artifactHash,
      findings: [],
      resolvedFingerprints: [],
      usage: { attemptId: delta.attemptId, tokens: null, costUsd: null },
    });
  }
  const third = {
    ...request('third'),
    kind: 'fix' as const,
    actorSeatId: 'coder',
    artifactRevision: state.artifactRevision,
    artifactHash: state.artifactHash,
    binding: { ...request('third').binding, accountId: 'coder', profileId: 'coder' },
  };
  expect(a.reserveApplicationAttempt(third)).toMatchObject({ code: 'cycles_exhausted' });
  expect(a.get('w')).toMatchObject({ hostTurns: 5, reviewCycles: 2 });
  a.close();
});
it('never attributes one accepted native operation to two host turns', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create({ ...create(), limits: { ...create().limits, maxReviewCycles: 2 } });
  a.reserveApplicationAttempt(request('one'));
  a.consumeApplicationDispatch(request('one'));
  a.bindApplicationOperation('w', 'one', 'same-operation');
  a.settleApplicationExecution('w', 'one', 'same-operation', 'failed');
  const retry = {
    ...request('retry'),
    kind: 'retry' as const,
    retryOfAttemptId: 'one',
    retryAuthorizationId: 'retry-auth',
  };
  a.reserveApplicationAttempt(retry);
  a.consumeApplicationDispatch(retry);
  expect(() => a.bindApplicationOperation('w', 'retry', 'same-operation')).toThrow(
    /already bound/i,
  );
  a.close();
});
