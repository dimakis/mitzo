import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  SeatConfig,
  SymposiumConfig,
  SymposiumDeliveryRecord,
  SymposiumRecipientAttemptRecord,
} from '@mitzo/protocol';
import {
  SymposiumReviewStore,
  type ApplicationAttempt,
  type ApplicationPolicy,
} from '../symposium-review-workflows.js';
import {
  createSymposiumTrustedReviewHost,
  type SymposiumTrustedReviewHostDeps,
} from '../symposium-trusted-review-host.js';
import type { NativeTurnObservation } from '../symposium-native-observations.js';
import type { SymposiumOrchestrator } from '../symposium-orchestrator.js';
import { canonicalReviewJson } from '../symposium-review-records.js';
const hash = 'a'.repeat(64),
  context = { owner: 'user', sessionId: 'session' };
const seat = (id: string, role: string): SeatConfig => ({
  id,
  name: id,
  role,
  model: 'offline',
  systemPrompt: 'test',
  color: '#123456',
  accountBinding: {
    accountId: id,
    accountLabel: id,
    provider: 'openai',
    model: 'offline',
    profileRevision: 'account-1',
  },
  profileBinding: { profileId: id, profileRevision: '1' },
  contextGrant: { grantId: 'context-' + id, revision: 1, classification: 'work', sourceRefs: [] },
  authorityGrant: {
    grantId: 'authority-' + id,
    revision: 1,
    filesystem: role === 'reviewer' ? 'read' : 'write',
    tools: role === 'reviewer' ? 'read' : 'write',
    network: 'restricted',
  },
  isolationRequest: { trustDomainId: 'domain', revision: 1, placement: 'reuse-compatible' },
});
function fixture(phase: 'initial' | 'review' = 'initial') {
  const reviews = new SymposiumReviewStore(':memory:');
  const seats = [seat('coder', 'coder'), seat('reviewer', 'reviewer')];
  const config = {
    version: 2,
    revision: 1,
    state: 'active',
    anchorSeatId: 'coder',
    activeSeatCap: 3,
    seats,
    turnRules: { mode: 'directed', maxTurns: 20 },
    interceptMode: 'manual',
  } as SymposiumConfig;
  const deliveries = new Map<string, SymposiumDeliveryRecord>();
  let execution: SymposiumRecipientAttemptRecord | undefined,
    observation: NativeTurnObservation | undefined;
  const runtime = {
    stageDelivery: vi.fn((input: Parameters<SymposiumOrchestrator['stageDelivery']>[0]) => {
      const selected = seats.find((s) => s.id === input.recipientSeatIds[0])!;
      const delivery = {
        ...input,
        deliveryId: 'delivery',
        configRevision: 1,
        status: 'awaiting_intervention',
        deliveredContent: null,
        recipients: [
          {
            seatId: selected.id,
            membershipGeneration: 1,
            configRevision: 1,
            accountProfileRevision: 'account-1',
            seatProfileRevision: '1',
            contextGrantId: selected.contextGrant!.grantId,
            contextGrantRevision: 1,
            authorityGrantId: selected.authorityGrant!.grantId,
            authorityGrantRevision: 1,
            status: 'pending',
          },
        ],
      } as unknown as SymposiumDeliveryRecord;
      deliveries.set('delivery', delivery);
      return delivery;
    }),
    intervene: vi.fn((input: Parameters<SymposiumOrchestrator['intervene']>[0]) => {
      const d = deliveries.get(input.deliveryId)!;
      d.status = 'ready';
      d.deliveredContent = d.originalContent;
      return d;
    }),
    deliver: vi.fn(async () => deliveries.get('delivery')),
    cancel: vi.fn(async () => deliveries.get('delivery')),
  };
  const deps = {
    events: {
      getActiveSymposiumConfig: () => config,
      getLatestSymposiumMembership: () => ({
        generation: 1,
        state: 'active',
        reconciliation: 'confirmed',
      }),
      getLatestSymposiumAdmission: () => ({
        decision: 'admitted',
        membershipGeneration: 1,
        configRevision: 1,
      }),
      getSymposiumDelivery: (id: string) => deliveries.get(id),
      getSymposiumRecipientAttemptByClaimToken: () => execution,
      getUnsettledSymposiumExecutions: () => [],
    },
    reviews,
    registry: {
      get: () => ({ state: 'confirmed', sessionId: 'session' }),
      observations: { get: () => observation },
    },
    runtime: () => runtime,
    profiles: () => ({ resume: () => {}, validateModelSelection: () => {} }),
    grants: { verifySeat: vi.fn() },
    selectedSeats: () => ({ implementerSeatId: 'coder', reviewerSeatId: 'reviewer' }),
    artifacts: {
      current: () => ({ revision: 'source', hash }),
      initial: () => ({ revision: 'source', hash }),
      refresh: vi.fn(async () => {}),
      result: () => null,
      evidence: () => null,
    },
    authorizeAction: vi.fn(() => null),
  } as unknown as SymposiumTrustedReviewHostDeps;
  const host = createSymposiumTrustedReviewHost(deps);
  const runInput = {
    workflowId: 'workflow',
    ...context,
    initialArtifact: { revision: 'source', hash },
    acceptanceCriteria: ['works'],
    limits: {
      version: 1 as const,
      mode: 'application' as const,
      maxHostTurns: 5,
      maxReviewCycles: 2,
      deadlineAt: Date.now() + 60000,
      noProgressLimit: 1,
    },
    ...host.selectApplicationRoles!(context),
  };
  if (phase === 'initial') reviews.createApplicationRun(runInput);
  else {
    const common = { ...runInput };
    delete (common as { initialArtifact?: unknown }).initialArtifact;
    reviews.create({
      ...common,
      implementation: {
        version: 1,
        resultId: 'fixture-result',
        attemptId: 'fixture-initial',
        inputRevision: 'source',
        inputHash: hash,
        artifactRevision: 'source',
        artifactHash: hash,
        summary: 'offline fixture',
        evidenceRefs: ['fixture'],
        completedAt: 1,
      },
    });
  }
  return {
    host,
    reviews,
    deps,
    runtime,
    deliveries,
    setCompletion: (e: SymposiumRecipientAttemptRecord, o: NativeTurnObservation) => {
      execution = e;
      observation = o;
    },
  };
}
describe('trusted production review adapter', () => {
  it('stages exact selected recipient but never dispatches during preparation', () => {
    const f = fixture();
    const state = f.reviews.get('workflow')!;
    const prepared = f.host.prepareApplicationAttempt!({
      context,
      workflowId: 'workflow',
      attemptId: 'initial',
      kind: 'initial',
      selection: state.implementer,
      artifactRevision: 'source',
      artifactHash: hash,
      policy: state.limits as ApplicationPolicy,
    });
    expect(prepared).toMatchObject({
      actorSeatId: 'coder',
      binding: {
        deliveryId: 'delivery',
        accountId: 'coder',
        authorityGrant: { grantId: 'authority-coder', revision: 1 },
      },
    });
    expect(f.runtime.deliver).not.toHaveBeenCalled();
    expect(f.runtime.intervene).not.toHaveBeenCalled();
    f.reviews.close();
  });
  it('never dispatches without the exact durable application reservation or fresh action authority', async () => {
    const f = fixture();
    await expect(
      f.host.dispatch(context, {
        kind: 'reserved_not_dispatched',
        attemptId: 'missing',
        selection: f.reviews.get('workflow')!.implementer,
        artifactRevision: 'source',
        artifactHash: hash,
      }),
    ).rejects.toThrow(/reservation/i);
    expect(
      f.host.authorizeContinuation!(
        context,
        'workflow',
        f.reviews.get('workflow')!.limits as ApplicationPolicy,
        'continue',
      ),
    ).toBeNull();
    expect(f.runtime.deliver).not.toHaveBeenCalled();
    f.reviews.close();
  });
  it('does not treat EventStore output alone as trusted native completion', () => {
    const f = fixture();
    expect(f.host.receipt(context, 'missing')).toBeNull();
    expect(f.host.completedReview(context, 'missing')).toBeNull();
    f.reviews.close();
  });
});

function prepare(f: ReturnType<typeof fixture>, kind: 'initial' | 'review') {
  const state = f.reviews.get('workflow')!;
  const planned = f.host.prepareApplicationAttempt!({
    context,
    workflowId: 'workflow',
    attemptId: kind,
    kind,
    selection: kind === 'review' ? state.reviewer : state.implementer,
    artifactRevision: 'source',
    artifactHash: hash,
    policy: state.limits as ApplicationPolicy,
  });
  if ('code' in planned) throw new Error(planned.code);
  f.reviews.reserveApplicationAttempt(planned);
  return planned;
}
function completed(f: ReturnType<typeof fixture>, planned: ApplicationAttempt, output: string) {
  f.reviews.consumeApplicationDispatch(planned);
  const selected = seat(
    planned.actorSeatId,
    planned.actorSeatId === 'reviewer' ? 'reviewer' : 'coder',
  );
  const provenance = {
    seatId: selected.id,
    membershipGeneration: 1,
    configRevision: 1,
    accountProfileRevision: 'account-1',
    seatProfileRevision: '1',
    authorityGrantRevision: 1,
    contextGrantRevision: 1,
    isolationDomainId: 'domain',
    isolationDomainRevision: 1,
  };
  const observation: NativeTurnObservation = {
    identity: {
      claimToken: planned.binding.claimToken,
      sessionId: 'session',
      seatId: selected.id,
      membershipGeneration: 1,
      accountBinding: selected.accountBinding!,
      provenance,
      providerThreadId: 'thread',
      providerTurnId: 'turn',
    },
    status: 'completed',
    acceptedAt: 1,
    terminalAt: 2,
    terminalConflict: false,
    usageStatus: 'unknown',
    observedUsage: null,
  };
  const execution: SymposiumRecipientAttemptRecord = {
    attemptId: 1,
    deliveryId: planned.binding.deliveryId,
    seatId: selected.id,
    attemptNumber: 1,
    idempotencyKey: 'recipient-key',
    claimToken: planned.binding.claimToken,
    dispatchedContent: 'prompt',
    dispatchSeq: 1,
    provenance,
    status: 'delivered',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    acceptedAt: 1,
    resultContent: output,
    costUsd: null,
    error: null,
    startedAt: 1,
    completedAt: 2,
    updatedAt: 2,
  };
  const id = canonicalReviewJson({ thread: 'thread', turn: 'turn' });
  f.reviews.bindApplicationOperation('workflow', planned.attemptId, id);
  f.reviews.settleApplicationExecution('workflow', planned.attemptId, id, 'completed');
  f.setCompletion(execution, observation);
  return { execution, observation };
}
it('joins durable native completion and parses only findings, preserving unknown usage', () => {
  const f = fixture('review');
  const planned = prepare(f, 'review');
  completed(f, planned, JSON.stringify({ findings: [], resolvedFingerprints: [] }));
  expect(f.host.receipt(context, 'review')).toMatchObject({
    kind: 'review',
    policyReservationId: planned.policyReservationId,
    tokens: null,
    costUsd: null,
  });
  expect(f.host.completedReview(context, 'review')).toMatchObject({
    artifactRevision: 'source',
    artifactHash: hash,
    findings: [],
    resolvedFingerprints: [],
  });
  const restarted = createSymposiumTrustedReviewHost(f.deps);
  expect(restarted.completedReview(context, 'review')).toEqual(
    f.host.completedReview(context, 'review'),
  );
  f.reviews.close();
});
it.each(['conflict', 'thread', 'account', 'grant', 'cleanup'] as const)(
  'rejects changed %s evidence without trusting model output',
  (issue) => {
    const f = fixture('review');
    const planned = prepare(f, 'review');
    const done = completed(f, planned, JSON.stringify({ findings: [], resolvedFingerprints: [] }));
    if (issue === 'conflict') done.observation.terminalConflict = true;
    if (issue === 'thread') done.execution.providerThreadId = 'different';
    if (issue === 'account') done.observation.identity.accountBinding.accountId = 'different';
    if (issue === 'grant')
      f.deliveries.get('delivery')!.recipients[0].authorityGrantId = 'different';
    if (issue === 'cleanup')
      f.deps.events.getUnsettledSymposiumExecutions = () => [
        {
          seatId: planned.actorSeatId,
          attemptId: 1,
          idempotencyKey: 'recipient-key',
          claimToken: planned.binding.claimToken,
        },
      ];
    expect(f.host.receipt(context, 'review')).toBeNull();
    expect(f.host.completedReview(context, 'review')).toBeNull();
    f.reviews.close();
  },
);
it('does not promote model-provided artifact or outcome claims into a trusted result', () => {
  const f = fixture();
  const planned = prepare(f, 'initial');
  completed(
    f,
    planned,
    JSON.stringify({ artifactHash: 'f'.repeat(64), verdict: 'verified', findings: [] }),
  );
  expect(f.host.initialResult!(context, 'initial')).toBeNull();
  expect(f.host.evidence(context, 'model-evidence')).toBeNull();
  f.reviews.close();
});
it('dispatches only the persisted approved delivery and awaits physical refresh', async () => {
  const f = fixture();
  const planned = prepare(f, 'initial');
  f.runtime.deliver.mockImplementation(async () => {
    completed(f, planned, 'done');
    return f.deliveries.get('delivery');
  });
  await f.host.dispatch(context, {
    kind: 'reserved_not_dispatched',
    attemptId: 'initial',
    policyReservationId: planned.policyReservationId,
    applicationAttempt: planned,
    selection: f.reviews.get('workflow')!.implementer,
    artifactRevision: 'source',
    artifactHash: hash,
  });
  expect(f.runtime.intervene).toHaveBeenCalledWith(
    expect.objectContaining({ deliveryId: 'delivery', action: 'approve' }),
  );
  expect(f.runtime.deliver).toHaveBeenCalledWith('delivery');
  expect(f.deps.artifacts.refresh).toHaveBeenCalledOnce();
  f.reviews.close();
});
it('reconciles a completed initial operation on a later request after a lost response', async () => {
  const f = fixture();
  const planned = prepare(f, 'initial');
  completed(f, planned, 'done');
  const reopened = createSymposiumTrustedReviewHost(f.deps);
  await reopened.refreshArtifact!(context);
  expect(f.deps.artifacts.refresh).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ attempt: expect.objectContaining({ attemptId: 'initial' }) }),
  );
  f.reviews.close();
});
it('rejects a changed staged prompt before approving or dispatching', async () => {
  const f = fixture();
  const planned = prepare(f, 'initial');
  f.deliveries.get('delivery')!.originalContent = 'changed prompt';
  await expect(
    f.host.dispatch(context, {
      kind: 'reserved_not_dispatched',
      attemptId: 'initial',
      policyReservationId: planned.policyReservationId,
      applicationAttempt: planned,
      selection: f.reviews.get('workflow')!.implementer,
      artifactRevision: 'source',
      artifactHash: hash,
    }),
  ).rejects.toThrow(/content/i);
  expect(f.runtime.intervene).not.toHaveBeenCalled();
  expect(f.runtime.deliver).not.toHaveBeenCalled();
  f.reviews.close();
});
it('charges a nonadmitting reader intent before applying confirmed future pins', async () => {
  const f = fixture('review');
  const preparation = {
    workflowId: 'workflow',
    attemptId: 'review',
    policyReservationId: 'reservation',
    kind: 'review' as const,
    actorSeatId: 'reviewer',
    artifactRevision: 'source',
    artifactHash: hash,
    transitionId: 'reader-transition',
    seal: {
      fenceId: 'fence',
      artifactGenerationId: 'gen',
      volumeName: 'volume',
      sealDigest: 'b'.repeat(64),
      artifactRevision: 'source',
      artifactHash: hash,
    },
    from: { configRevision: 1, membershipGeneration: 1 },
    to: { configRevision: 2, membershipGeneration: 2 },
    expectedSelection: {
      accountId: 'reviewer',
      model: 'offline',
      profileId: 'reviewer',
      profileRevision: '1',
      accountProfileRevision: 'account-1',
    },
  };
  const final = {
    workflowId: 'workflow',
    attemptId: 'review',
    policyReservationId: 'reservation',
    kind: 'review' as const,
    actorSeatId: 'reviewer',
    artifactRevision: 'source',
    artifactHash: hash,
    binding: {
      claimToken: 'claim',
      deliveryId: 'delivery',
      contentHash: createHash('sha256').update('fixture').digest('hex'),
      membershipGeneration: 2,
      configRevision: 2,
      accountId: 'reviewer',
      model: 'offline',
      profileId: 'reviewer',
      profileRevision: '1',
      accountProfileRevision: 'account-1',
      authorityGrant: { grantId: 'future', revision: 2 },
      contextGrant: { grantId: 'future-context', revision: 2 },
    },
  };
  const apply = vi.fn(async () => {
    expect(f.reviews.get('workflow')).toMatchObject({ hostTurns: 1, reviewCycles: 1 });
    expect(f.reviews.applicationAttemptForClaim('claim')).toBeNull();
    f.runtime.stageDelivery({
      sessionId: 'session',
      sourceSeatId: null,
      recipientSeatIds: ['reviewer'],
      originalContent: 'fixture',
      idempotencyKey: 'reader-transition',
    });
    return {
      attempt: final,
      proof: { transitionId: 'reader-transition', sealDigest: 'b'.repeat(64) },
    };
  });
  f.deps.transition = { prepare: vi.fn(async () => preparation), apply };
  const host = createSymposiumTrustedReviewHost(f.deps);
  const { SymposiumReviewCoordinator } = await import('../symposium-review-coordinator.js');
  const coordinator = new SymposiumReviewCoordinator(f.reviews, host);
  const reserved = await coordinator.reserveWithTransition(context, 'workflow', 'review', 'review');
  expect(reserved).toMatchObject({
    kind: 'reserved_not_dispatched',
    policyReservationId: 'reservation',
  });
  expect(f.reviews.get('workflow')).toMatchObject({ hostTurns: 1, reviewCycles: 1 });
  expect(apply).toHaveBeenCalledOnce();
  expect(f.reviews.applicationAttemptForClaim('claim')).toEqual(final);
  f.reviews.close();
});
