import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import {
  createSymposiumProductionReviewComposition,
  historicalFixPointer,
  historicalSealedResultCoderGeneration,
  sealWithRetiredReviewRuntime,
  assertCompletedReaderClaimsSettled,
} from '../symposium-production-review-composition.js';

it('retires only the exact drained runtime after a physical seal completes', async () => {
  const current = {},
    runtime = {};
  const seal = vi.fn(async () => 'sealed');
  const retire = vi.fn();
  expect(
    await sealWithRetiredReviewRuntime({
      current,
      retained: { orchestrator: current, runtime },
      seal,
      retire,
    }),
  ).toBe('sealed');
  expect(seal).toHaveBeenCalledWith(runtime);
  expect(retire).toHaveBeenCalledWith(runtime);
  expect(seal.mock.invocationCallOrder[0]).toBeLessThan(retire.mock.invocationCallOrder[0]);
  seal.mockRejectedValueOnce(new Error('seal uncertain'));
  await expect(
    sealWithRetiredReviewRuntime({
      current,
      retained: { orchestrator: current, runtime },
      seal,
      retire,
    }),
  ).rejects.toThrow('seal uncertain');
  expect(retire).toHaveBeenCalledTimes(1);
  await expect(
    sealWithRetiredReviewRuntime({
      current,
      retained: { orchestrator: {}, runtime },
      seal,
      retire,
    }),
  ).rejects.toThrow('Exact retained native runtime');
  expect(seal).toHaveBeenCalledTimes(2);
});

it('uses a completed imported source until a physically sealed writer result exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'symposium-review-composition-'));
  const source = {
    receipt: {
      sessionId: 'session',
      operationId: 'source-seal',
      volumeGeneration: 'source-generation',
      volumeName: 'source-volume',
      git: { commit: 'a'.repeat(40), committedTreeDigest: 'b'.repeat(64) },
    },
    digest: 'c'.repeat(64),
    exported: { receipt: { selection: { defaultBranch: 'main' } } },
  };
  const host = {
    gateway: { workspace: 'workspace' },
    sourceImport: { requireSeal: vi.fn(() => source), initialExport: vi.fn() },
    sealSessionArtifacts: vi.fn(),
    requireCompletedArtifactSeal: vi.fn(),
    inspectCompletedArtifact: vi.fn(),
    exportCompletedReviewContext: vi.fn(),
    releaseCompletedReviewStream: vi.fn(),
    releaseReadyReviewStream: vi.fn(),
    releaseStoppedReadyReviewStream: vi.fn(),
    trackApplicationTransition: (operation: () => Promise<unknown>) => operation(),
    exportSuccessorArtifactBundle: vi.fn(),
    copySuccessorArtifact: vi.fn(),
    activateSuccessorArtifact: vi.fn(),
    admitSuccessorArtifact: vi.fn(),
    inspectStoppedSuccessorOperation: vi.fn(),
    assertArtifactAdmissionCurrent: vi.fn(),
    artifactLeaseHost: {},
    attemptRegistry: { observations: {}, get: vi.fn() },
    currentProfiles: vi.fn(),
  };
  try {
    const composed = createSymposiumProductionReviewComposition({
      host,
      events: {},
      reviews: {},
      grants: {},
      actionAuthority: {},
      artifactResultsPath: join(directory, 'results.db'),
      runtime: vi.fn(),
      retainedRuntime: vi.fn(),
    } as never);
    const context = { owner: 'user', sessionId: 'session' };
    expect(composed.reviewHost.initialArtifact!(context)).toEqual({
      revision: source.receipt.git.commit,
      hash: source.receipt.git.committedTreeDigest,
    });
    expect(composed.reviewHost.currentArtifact(context)).toEqual({
      revision: source.receipt.git.commit,
      hash: source.receipt.git.committedTreeDigest,
    });
    expect(host.sourceImport.requireSeal).toHaveBeenCalledWith('session');
    expect(host.copySuccessorArtifact).not.toHaveBeenCalled();
    composed.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not install a review host from partial physical capabilities', () => {
  expect(() =>
    createSymposiumProductionReviewComposition({
      host: { sourceImport: { requireSeal: vi.fn(), initialExport: vi.fn() } },
      events: {},
      reviews: {},
      grants: {},
      actionAuthority: {},
      artifactResultsPath: '/unused',
      runtime: vi.fn(),
      retainedRuntime: vi.fn(),
    } as never),
  ).toThrow('Complete trusted physical review host required');
});

it('reads the sealed coder pointer after a reviewer config transition without issuing it for dispatch', () => {
  const ref = {
    version: 1,
    transitionId: 'initial',
    artifactGenerationId: 'writer-generation',
    pointerRevision: 1,
    bindingDigest: 'a'.repeat(64),
  };
  const seal = {
    fenceId: 'writer-seal',
    selection: { sessionId: 'session', artifact: { volumeGeneration: 'writer-generation' } },
    memberships: [{ seatId: 'coder', generation: 2 }],
  };
  const snapshot = vi.fn((_value, fn: () => void) => fn());
  const binding = {
    sessionId: 'session',
    seatId: 'coder',
    childGenerationId: 'writer-generation',
    successorMembershipGeneration: 2,
    resultingConfigRevision: 2,
  };
  const events = {
    getActiveSymposiumConfig: () => ({
      version: 2,
      state: 'active',
      revision: 3,
      seats: [
        { id: 'coder', role: 'coder' },
        { id: 'reviewer', role: 'reviewer' },
      ],
    }),
    getLatestSymposiumMembership: () => ({
      state: 'active',
      reconciliation: 'confirmed',
      generation: 2,
    }),
    getSymposiumArtifactReference: () => ref,
    getSymposiumArtifactAdmission: () => ({
      reference: ref,
      receipt: {
        bindingDigest: artifactAdmissionDigest(binding),
        pointerRevision: 1,
      },
      binding,
    }),
    getSymposiumArtifactSealByFence: (fenceId: string) => (fenceId === 'writer-seal' ? seal : null),
    withSymposiumHistoricalArtifactSealSnapshot: snapshot,
    assertSymposiumArtifactAdmissionCurrent: vi.fn(() => {
      throw new Error('old config');
    }),
  };
  expect(
    historicalFixPointer(
      events as never,
      { owner: 'user', sessionId: 'session' },
      'coder',
      2,
      'writer-generation',
      'writer-seal',
    ),
  ).toEqual(ref);
  expect(snapshot).toHaveBeenCalledOnce();
  expect(events.assertSymposiumArtifactAdmissionCurrent).not.toHaveBeenCalled();
  expect(
    historicalSealedResultCoderGeneration(
      events as never,
      {
        owner: 'user',
        sessionId: 'session',
      },
      { evidenceRefs: ['artifact-seal:writer-seal'] },
    ),
  ).toBe('writer-generation');
  expect(events.assertSymposiumArtifactAdmissionCurrent).not.toHaveBeenCalled();
  expect(() =>
    historicalSealedResultCoderGeneration(
      events as never,
      { owner: 'user', sessionId: 'session' },
      { evidenceRefs: ['artifact-seal:different-seal'] },
    ),
  ).toThrow('sealed coder');
  expect(() =>
    historicalSealedResultCoderGeneration(
      {
        ...events,
        getLatestSymposiumMembership: () => ({
          state: 'active',
          reconciliation: 'confirmed',
          generation: 3,
        }),
      } as never,
      { owner: 'user', sessionId: 'session' },
      { evidenceRefs: ['artifact-seal:writer-seal'] },
    ),
  ).toThrow('sealed coder');
  expect(() =>
    historicalFixPointer(
      events as never,
      { owner: 'user', sessionId: 'session' },
      'coder',
      2,
      'different-generation',
      'writer-seal',
    ),
  ).toThrow('sealed coder pointer');
});

it('reconciles the exact retired writer seal after a lost response without allocating a runtime', async () => {
  // Offline receipt fixture; physical validity is covered by the opt-in application contract.
  const directory = mkdtempSync(join(tmpdir(), 'symposium-retired-seal-'));
  const context = { owner: 'user', sessionId: 'session' };
  const hash = (value: string) => value.repeat(64);
  const binding = {
    claimToken: 'claim',
    deliveryId: 'delivery',
    contentHash: hash('a'),
    membershipGeneration: 2,
    configRevision: 2,
    accountId: 'coder',
    model: 'offline',
    profileId: 'coder',
    profileRevision: '1',
    accountProfileRevision: '1',
    authorityGrant: { grantId: 'authority', revision: 1 },
    contextGrant: { grantId: 'context', revision: 1 },
  };
  const accountBinding = {
    accountId: 'coder',
    accountLabel: 'Coder',
    provider: 'openai' as const,
    model: 'offline',
    profileRevision: '1',
  };
  const artifact = {
    version: 1,
    transitionId: 'initial',
    artifactGenerationId: 'writer',
    pointerRevision: 1,
    bindingDigest: hash('b'),
  };
  const provenance = {
    version: 3,
    seatId: 'coder',
    membershipGeneration: 2,
    configRevision: 2,
    accountProfileRevision: '1',
    seatProfileRevision: '1',
    authorityGrantRevision: 1,
    contextGrantRevision: 1,
    artifact,
  };
  const attempt = {
    workflowId: 'workflow',
    attemptId: 'initial',
    policyReservationId: 'policy',
    kind: 'initial',
    actorSeatId: 'coder',
    artifactRevision: 'source',
    artifactHash: hash('c'),
    binding,
    dispatched: true,
    settled: true,
    operationId: '{"thread":"thread","turn":"turn"}',
  };
  const execution = {
    deliveryId: 'delivery',
    seatId: 'coder',
    claimToken: 'claim',
    status: 'delivered',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    completedAt: 10,
    provenance,
  };
  const observation = {
    status: 'completed',
    terminalAt: 10,
    terminalConflict: false,
    identity: {
      claimToken: 'claim',
      sessionId: 'session',
      seatId: 'coder',
      membershipGeneration: 2,
      accountBinding,
      provenance,
      providerThreadId: 'thread',
      providerTurnId: 'turn',
    },
  };
  const selection = {
    sessionId: 'session',
    expectedConfigRevision: 2,
    idempotencyKey: `review-seal-${createHash('sha256').update('initial').digest('hex')}`,
    artifact: { volumeGeneration: 'writer' },
  };
  const intent = { fenceId: 'fence', capturedAt: 11, selection };
  const seal = {
    kind: 'completed_artifact_seal',
    version: 1,
    fenceId: 'fence',
    sessionId: 'session',
    custodyDigest: hash('d'),
    intentDigest: hash('e'),
    retentionDigest: hash('f'),
    revocationDigest: hash('1'),
    repositoryPath: '.',
    git: {
      version: 1,
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      entries: 1,
      bytes: 1,
      manifestDigest: hash('2'),
      committedTreeDigest: hash('3'),
    },
    verifier: { id: hash('4'), image: 'offline', codeDigest: hash('5') },
    completedAt: 12,
  };
  let changed: 'key' | 'config' | 'generation' | 'session' | null = null;
  let unrelatedRuntime: { orchestrator: object; runtime: object } | null = null;
  const retire = vi.fn();
  const requireCompleted = vi.fn(async () => seal);
  requireCompleted.mockRejectedValueOnce(new Error('Lost completed-seal response'));
  const runtime = vi.fn(() => {
    throw Error('Must not allocate a replacement runtime');
  });
  const sealSessionArtifacts = vi.fn();
  const host = {
    gateway: { workspace: 'fixture' },
    sourceImport: {
      requireSeal: () => ({
        receipt: {
          sessionId: 'session',
          git: { commit: 'source', committedTreeDigest: hash('c') },
        },
      }),
      initialExport: vi.fn(),
    },
    sealSessionArtifacts,
    requireCompletedArtifactSeal: requireCompleted,
    inspectCompletedArtifact: vi.fn(),
    exportCompletedReviewContext: vi.fn(),
    releaseCompletedReviewStream: vi.fn(),
    releaseReadyReviewStream: vi.fn(),
    releaseStoppedReadyReviewStream: vi.fn(),
    trackApplicationTransition: vi.fn(),
    exportSuccessorArtifactBundle: vi.fn(),
    copySuccessorArtifact: vi.fn(),
    admitSuccessorArtifact: vi.fn(),
    inspectStoppedSuccessorOperation: vi.fn(),
    assertArtifactAdmissionCurrent: vi.fn(),
    artifactLeaseHost: {},
    attemptRegistry: {
      observations: { get: () => observation },
      get: () => ({ state: 'confirmed', sessionId: 'session' }),
    },
    currentProfiles: vi.fn(),
  };
  const events = {
    getSymposiumArtifactSealIntent: vi.fn(() => ({
      ...intent,
      selection: {
        ...selection,
        ...(changed === 'key' ? { idempotencyKey: 'different-attempt' } : {}),
        ...(changed === 'config' ? { expectedConfigRevision: 3 } : {}),
        ...(changed === 'generation' ? { artifact: { volumeGeneration: 'other' } } : {}),
        ...(changed === 'session' ? { sessionId: 'other' } : {}),
      },
    })),
    getSymposiumArtifactSealByFence: () => intent,
    getActiveSymposiumConfig: () => ({ seats: [{ id: 'coder', role: 'coder' }] }),
    getLatestSymposiumMembership: () => ({ generation: 2 }),
    getSymposiumArtifactReference: () => artifact,
    assertSymposiumArtifactAdmissionCurrent: vi.fn(),
    getSymposiumRecipientAttemptByClaimToken: () => execution,
    getUnsettledSymposiumExecutions: () => [],
    getSymposiumDelivery: () => ({
      sessionId: 'session',
      configRevision: 2,
      recipients: [
        {
          seatId: 'coder',
          membershipGeneration: 2,
          accountProfileRevision: '1',
          seatProfileRevision: '1',
          authorityGrantId: 'authority',
          authorityGrantRevision: 1,
          contextGrantId: 'context',
          contextGrantRevision: 1,
        },
      ],
    }),
  };
  const reviews = {
    applicationWorkflowForSession: () => ({
      owner: 'user',
      sessionId: 'session',
      limits: { version: 1, mode: 'application' },
      applicationAttempts: [attempt],
    }),
    get: () => ({ owner: 'user', sessionId: 'session', applicationAttempts: [attempt] }),
    applicationAttemptForClaim: () => attempt,
  };
  const compose = () =>
    createSymposiumProductionReviewComposition({
      host,
      events,
      reviews,
      grants: {},
      actionAuthority: {},
      artifactResultsPath: join(directory, 'results.db'),
      runtime,
      retainedRuntime: () => unrelatedRuntime,
      retireSealedRuntime: retire,
    } as never);
  let composed = compose();
  try {
    await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
      'Lost completed-seal response',
    );
    unrelatedRuntime = { orchestrator: {}, runtime: {} };
    for (const mismatch of ['key', 'config', 'generation', 'session'] as const) {
      changed = mismatch;
      await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
        'Retained review artifact seal identity changed',
      );
    }
    changed = null;
    requireCompleted.mockRejectedValueOnce(
      new Error('Completed artifact seal custody is unavailable'),
    );
    await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
      'Completed artifact seal custody is unavailable',
    );
    await composed.reviewHost.refreshArtifact!(context);
    composed.close();
    composed = compose();
    await composed.reviewHost.refreshArtifact!(context);
    expect(composed.reviewHost.currentArtifact(context)).toEqual({
      revision: seal.git.commit,
      hash: seal.git.committedTreeDigest,
    });
    expect(runtime).not.toHaveBeenCalled();
    expect(sealSessionArtifacts).not.toHaveBeenCalled();
    expect(requireCompleted).toHaveBeenCalledTimes(4);
    expect(retire).not.toHaveBeenCalled();
    expect(events.getSymposiumArtifactSealIntent).toHaveBeenCalledWith('session', 'writer');
  } finally {
    composed.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fences completed reader retirement on unresolved original claims and preparations', () => {
  const pending = vi.fn(() => []);
  const pendingPreparations = vi.fn(() => []);
  const registry = { pending, pendingPreparations };
  expect(() => assertCompletedReaderClaimsSettled(registry, 'session')).not.toThrow();
  pendingPreparations.mockReturnValue([{ sessionId: 'session' }] as never);
  expect(() => assertCompletedReaderClaimsSettled(registry, 'session')).toThrow('unresolved work');
  pendingPreparations.mockReturnValue([{ sessionId: 'unrelated' }] as never);
  expect(() => assertCompletedReaderClaimsSettled(registry, 'session')).not.toThrow();
  pending.mockReturnValue([{ sessionId: 'session' }] as never);
  expect(() => assertCompletedReaderClaimsSettled(registry, 'session')).toThrow('unresolved work');
});
