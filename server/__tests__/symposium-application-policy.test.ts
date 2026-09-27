import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import {
  SymposiumReviewCoordinator,
  type SymposiumReviewHost,
} from '../symposium-review-coordinator.js';
import { createSymposiumSuccessorFixAuthority } from '../symposium-artifact-successor-authority.js';
import type { ArtifactAdmissionBindingV1, SeatConfig } from '@mitzo/protocol';
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
  it('persists the initial charge before a trusted child owner can stage a claim', async () => {
    const a = new SymposiumReviewStore(':memory:');
    const { implementation, ...base } = create();
    expect(implementation).toBeDefined();
    a.createApplicationRun({ ...base, initialArtifact: { revision: 'i', hash } });
    const preparation = {
      workflowId: 'w',
      attemptId: 'initial-attempt',
      policyReservationId: 'policy-initial',
      kind: 'initial' as const,
      sourceSealId: 'source-fence',
      actorSeatId: 'coder',
      artifactRevision: 'i',
      artifactHash: hash,
      transitionId: 'initial-child',
      seal: {
        fenceId: 'source-fence',
        artifactGenerationId: 'source',
        volumeName: 'source-volume',
        sealDigest: hash,
        artifactRevision: 'i',
        artifactHash: hash,
      },
      from: { configRevision: 1, membershipGeneration: 1 },
      to: { configRevision: 2, membershipGeneration: 2 },
      expectedSelection: {
        accountId: 'coder',
        model: 'offline',
        profileId: 'coder',
        profileRevision: '1',
        accountProfileRevision: '1',
      },
    };
    const selected = request('initial-attempt');
    const attempt = {
      ...selected,
      policyReservationId: 'policy-initial',
      kind: 'initial' as const,
      actorSeatId: 'coder',
      artifactRevision: 'i',
      binding: {
        ...selected.binding,
        claimToken: 'claim-initial',
        deliveryId: 'delivery-initial',
        configRevision: 2,
        membershipGeneration: 2,
        accountId: 'coder',
        profileId: 'coder',
      },
    };
    let staged = false;
    const host = {
      currentArtifact: () => ({ revision: 'i', hash }),
      prepareApplicationTransition: async () => preparation,
      completeApplicationTransition: async () => {
        expect(a.getApplicationPreparation('w', 'initial-attempt')).toMatchObject({
          status: 'preparing',
        });
        expect(a.get('w')).toMatchObject({ hostTurns: 1, applicationAttempts: [] });
        staged = true;
        return { attempt, proof: { transitionId: 'initial-child', sealDigest: hash } };
      },
    } as unknown as SymposiumReviewHost;
    const result = await new SymposiumReviewCoordinator(a, host).reserveWithTransition(
      { owner: 'user', sessionId: 's' },
      'w',
      'initial',
      'initial-attempt',
    );
    expect(staged).toBe(true);
    expect(result).toMatchObject({ kind: 'reserved_not_dispatched', attemptId: 'initial-attempt' });
    expect(a.getApplicationPreparation('w', 'initial-attempt')).toMatchObject({ status: 'bound' });
    a.close();
  });
  it('charges a sealed-source initial transition before any native claim exists', () => {
    const a = new SymposiumReviewStore(':memory:');
    const { implementation, ...base } = create();
    expect(implementation).toBeDefined();
    a.createApplicationRun({ ...base, initialArtifact: { revision: 'i', hash } });
    const preparation = {
      workflowId: 'w',
      attemptId: 'initial-attempt',
      policyReservationId: 'policy-initial',
      kind: 'initial' as const,
      actorSeatId: 'coder',
      artifactRevision: 'i',
      artifactHash: hash,
      transitionId: 'initial-child',
      sourceSealId: 'source-fence',
      seal: {
        fenceId: 'source-fence',
        artifactGenerationId: 'source',
        volumeName: 'source-volume',
        sealDigest: hash,
        artifactRevision: 'i',
        artifactHash: hash,
      },
      from: { configRevision: 1, membershipGeneration: 1 },
      to: { configRevision: 2, membershipGeneration: 2 },
      expectedSelection: {
        accountId: 'coder',
        model: 'offline',
        profileId: 'coder',
        profileRevision: '1',
        accountProfileRevision: '1',
      },
    };
    expect(a.reserveApplicationPreparation(preparation)).toMatchObject({ kind: 'prepared' });
    expect(a.get('w')).toMatchObject({ hostTurns: 1, reviewCycles: 0, applicationAttempts: [] });
    expect(a.reserveApplicationPreparation(preparation)).toMatchObject({
      kind: 'already_prepared',
    });
    a.close();
  });
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
it('requires a charged fix preparation and current grant for successor admission', () => {
  const a = new SymposiumReviewStore(':memory:');
  a.create(create());
  a.reserveApplicationAttempt(request('one'));
  const reviewed = terminalReview(a, 'one', [
    { criterion: 'works', summary: 'missing', location: 'file', evidenceRefs: ['diff'] },
  ]);
  const fingerprints = [reviewed.findings[0].fingerprint];
  a.authorizeApplicationFixIntent({
    workflowId: 'w',
    artifactRevision: 'a',
    artifactHash: hash,
    actor: 'user',
    authorizationId: 'action',
    findingFingerprints: fingerprints,
    reason: 'fix',
  });
  const prep = {
    workflowId: 'w',
    attemptId: 'fix',
    policyReservationId: 'reservation',
    kind: 'fix' as const,
    actorSeatId: 'coder',
    artifactRevision: 'a',
    artifactHash: hash,
    transitionId: 'transition',
    seal: {
      fenceId: 'fence',
      artifactGenerationId: 'parent',
      volumeName: 'volume',
      sealDigest: hash,
      artifactRevision: 'a',
      artifactHash: hash,
    },
    from: { configRevision: 2, membershipGeneration: 1 },
    to: { configRevision: 3, membershipGeneration: 2 },
    expectedSelection: {
      accountId: 'coder',
      model: 'offline',
      profileId: 'coder',
      profileRevision: '1',
      accountProfileRevision: '1',
    },
  };
  const binding = {
    version: 1,
    transitionId: 'transition',
    operationId: 'copy',
    sessionId: 's',
    workspaceId: 'workspace',
    custodyDigest: hash,
    parentGenerationId: 'parent',
    parentFenceId: 'fence',
    parentSealDigest: hash,
    childGenerationId: 'child',
    childVolumeName: 'child-volume',
    copyReceiptDigest: hash,
    expectedPointerRevision: 0,
    activatedPointerRevision: 1,
    workflowId: 'w',
    fixAttemptId: 'fix',
    policyReservationId: 'reservation',
    seatId: 'coder',
    actor: 'user',
    expectedConfigRevision: 2,
    resultingConfigRevision: 3,
    predecessorMembershipGeneration: 1,
    successorMembershipGeneration: 2,
    accountBinding: {
      accountId: 'coder',
      accountLabel: 'coder',
      provider: 'openai',
      model: 'offline',
      profileRevision: '1',
    },
    profileBinding: { profileId: 'coder', profileRevision: '1' },
    contextGrant: { grantId: 'context', revision: 1 },
    authorityGrant: { grantId: 'grant', revision: 1 },
    findingFingerprints: fingerprints,
  } as ArtifactAdmissionBindingV1;
  const seat = {
    id: 'coder',
    name: 'coder',
    role: 'coder',
    model: 'offline',
    systemPrompt: 'offline',
    color: '#123456',
    accountBinding: binding.accountBinding,
    profileBinding: binding.profileBinding,
    authorityGrant: {
      ...binding.authorityGrant,
      filesystem: 'write',
      tools: 'write',
      network: 'restricted',
    },
    contextGrant: { ...binding.contextGrant, classification: 'work', sourceRefs: [] },
  } as SeatConfig;
  let generation = 1,
    revision = 2,
    historical = true;
  const authority = createSymposiumSuccessorFixAuthority({
    workflows: a,
    events: {
      getActiveSymposiumConfig: () => ({ version: 2, revision, state: 'active', seats: [seat] }),
      getLatestSymposiumMembership: () => ({
        generation,
        state: 'active',
        reconciliation: 'confirmed',
      }),
      getLatestSymposiumAdmission: () => ({
        decision: 'admitted',
        membershipGeneration: 1,
        configRevision: 1,
        provider: 'openai',
        accountId: 'coder',
        model: 'offline',
        accountProfileRevision: '1',
      }),
      getSymposiumArtifactSealByFence: () => ({
        fenceId: 'fence',
        selection: {
          sessionId: 's',
          expectedConfigRevision: 1,
          artifact: { volumeGeneration: 'parent' },
        },
        memberships: [
          { seatId: 'coder', generation: 1, state: 'active', reconciliation: 'confirmed' },
        ],
      }),
      withSymposiumHistoricalArtifactSealSnapshot: (_intent: unknown, action: () => void) => {
        if (!historical) throw new Error('Historical successor revision chain changed');
        action();
      },
    } as unknown as Parameters<typeof createSymposiumSuccessorFixAuthority>[0]['events'],
    grants: { verifySeat: () => {} },
  });
  expect(() => authority.assertAdmissionCurrent!(binding)).toThrow(/preparation/i);
  a.reserveApplicationPreparation(prep);
  expect(authority.assertAdmissionCurrent!(binding)).toBe(true);
  // The reader advances config after sealing; ordinary coder admission is
  // fenced until a successor exists, but its sealed predecessor is provable.
  revision = 2;
  const predecessor = {
    sessionId: 's',
    workflowId: 'w',
    fixAttemptId: 'fix',
    actor: 'user',
    seatId: 'coder',
    membershipGeneration: 1,
    accountId: 'coder',
    model: 'offline',
    profileId: 'coder',
    profileRevision: '1',
    authorityGrantId: 'grant',
    authorityRevision: 1,
    parentGenerationId: 'parent',
    parentSealDigest: hash,
    parentCommit: 'a',
    parentCommittedTreeDigest: hash,
    findingFingerprints: fingerprints,
  } as Parameters<typeof authority.assertCurrent>[0];
  expect(authority.assertCurrent(predecessor)).toBe(true);
  historical = false;
  expect(() => authority.assertCurrent(predecessor)).toThrow(/Historical/);
  historical = true;
  revision = 2;
  expect(() =>
    authority.assertAdmissionCurrent!({
      ...binding,
      authorityGrant: { grantId: 'stale', revision: 1 },
    }),
  ).toThrow(/binding/i);
  generation = 2;
  revision = 3;
  expect(authority.assertAdmissionCurrent!(binding)).toBe(true);
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
  expect(() =>
    a.authorizeFix({
      workflowId: 'w',
      artifactRevision: 'a',
      artifactHash: hash,
      actor: 'user',
      authorityGrantId: 'stale',
      authorityRevision: 1,
      findingFingerprints: [state.findings[0].fingerprint],
      reason: 'fix',
    }),
  ).toThrow(/interactive fix intent/i);
  a.authorizeApplicationFixIntent({
    workflowId: 'w',
    artifactRevision: 'a',
    artifactHash: hash,
    actor: 'user',
    authorizationId: 'fix-action',
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
    a.authorizeApplicationFixIntent({
      workflowId: 'w',
      artifactRevision: revision,
      artifactHash,
      actor: 'user',
      authorizationId: 'fix-action-' + cycle,
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
