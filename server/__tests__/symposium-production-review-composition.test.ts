import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sessionRuntime from '../symposium-session-runtime.js';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import {
  createSymposiumProductionReviewComposition,
  historicalFixPointer,
  historicalSealedResultCoderGeneration,
  sealWithRetiredReviewRuntime,
  assertCompletedReaderClaimsSettled,
  hasCompletedReaderCleanupProof,
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

async function exerciseWriterSealRecovery(pending: boolean, restarted = false) {
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
  const intent = {
    fenceId: 'fence',
    capturedAt: 11,
    status: 'pending_unsealed',
    selection,
  };
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
  const original = { orchestrator: {}, runtime: {} };
  const runtime = vi.fn(() => {
    if (pending) return original.orchestrator;
    throw Error('Must not allocate a replacement runtime');
  });
  const sealSessionArtifacts = vi.fn(
    async (_input: unknown, _runtime: object, _signal: AbortSignal) => {
      requireCompleted.mockResolvedValue(seal);
      return seal;
    },
  );
  if (pending) {
    unrelatedRuntime = original;
    requireCompleted.mockReset().mockRejectedValue(new Error('Artifact seal remains pending'));
    sealSessionArtifacts.mockRejectedValueOnce(new Error('Original writer drain response lost'));
  }
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
    ...(restarted
      ? {
          recoverPendingArtifactSeal: vi.fn(async (_input: unknown, claim: string) => {
            expect(claim).toBe(binding.claimToken);
            requireCompleted.mockResolvedValue(seal);
            return seal;
          }),
        }
      : {}),
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
  const pendingMarker = pending
    ? vi
        .spyOn(sessionRuntime, 'isSymposiumRuntimeSealingForFence')
        .mockImplementation(
          (candidate, store, lease, session, fence) =>
            candidate === original.runtime &&
            Object.is(store, events) &&
            lease === host.artifactLeaseHost &&
            session === 'session' &&
            fence === 'fence',
        )
    : null;
  let composed = compose();
  try {
    await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
      pending ? 'Original writer drain response lost' : 'Lost completed-seal response',
    );
    if (pending && restarted) {
      // Process-local runtime witnesses disappear; the retained physical seal
      // operation and original completed native claim remain durable authority.
      composed.close();
      unrelatedRuntime = null;
      composed = compose();
      await composed.reviewHost.refreshArtifact!(context);
      expect(composed.reviewHost.currentArtifact(context)).toEqual({
        revision: seal.git.commit,
        hash: seal.git.committedTreeDigest,
      });
      expect(retire).not.toHaveBeenCalled();
      return;
    }
    if (pending) {
      expect(retire).not.toHaveBeenCalled();
      for (const unavailable of [null, { orchestrator: {}, runtime: {} }]) {
        unrelatedRuntime = unavailable;
        await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
          'Artifact seal remains pending',
        );
      }
      unrelatedRuntime = { orchestrator: {}, runtime: original.runtime };
      await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
        'Exact retained native runtime required',
      );
      unrelatedRuntime = original;
      pendingMarker!.mockReturnValueOnce(false);
      await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
        'Artifact seal remains pending',
      );
      for (const mismatch of ['key', 'config', 'generation', 'session'] as const) {
        changed = mismatch;
        await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
          'Retained review artifact seal identity changed',
        );
      }
      changed = null;
      expect(sealSessionArtifacts).toHaveBeenCalledTimes(1);
      expect(retire).not.toHaveBeenCalled();
      await composed.reviewHost.refreshArtifact!(context);
      expect(sealSessionArtifacts).toHaveBeenCalledTimes(2);
      for (const call of sealSessionArtifacts.mock.calls) {
        expect(call[0]).toEqual({
          sessionId: 'session',
          expectedConfigRevision: 2,
          idempotencyKey: selection.idempotencyKey,
          repositoryPath: '.',
        });
        expect(call[1]).toBe(original.runtime);
      }
      expect(retire).toHaveBeenCalledExactlyOnceWith('session', original.runtime);
      expect(requireCompleted).toHaveBeenCalledTimes(4);
      expect(requireCompleted.mock.invocationCallOrder[3]).toBeGreaterThan(
        sealSessionArtifacts.mock.invocationCallOrder[1],
      );
      return;
    }
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
    pendingMarker?.mockRestore();
    composed.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

it('reconciles the exact retired writer seal after a lost response without allocating a runtime', async () => {
  await exerciseWriterSealRecovery(false);
});

it('resumes the original pending writer seal after a failed drain without a new request', async () => {
  await exerciseWriterSealRecovery(true);
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

it('requires exact stopped historical reader proof and preserves an unrelated fresh runtime', () => {
  const reference = {
    version: 1,
    kind: 'sealed_reader',
    readerAdmissionId: 'reader',
    sealFenceId: 'old',
    artifactGenerationId: 'old-generation',
    bindingDigest: 'digest',
  };
  const binding = {
    sessionId: 'session',
    workflowId: 'workflow',
    reviewAttemptId: 'review',
    policyReservationId: 'policy',
    seatId: 'reader',
    readerMembershipGeneration: 2,
    resultingConfigRevision: 3,
    sealFenceId: 'old',
    artifactGenerationId: 'old-generation',
    sealDigest: 'a'.repeat(64),
  };
  const completion = {
    attempt: {
      workflowId: 'workflow',
      attemptId: 'review',
      actorSeatId: 'reader',
      policyReservationId: 'policy',
      artifactRevision: 'old-commit',
      artifactHash: 'old-hash',
      binding: { claimToken: 'claim', membershipGeneration: 2, configRevision: 3 },
    },
    execution: { provenance: { version: 3, artifact: reference } },
    observation: { status: 'completed', terminalConflict: false, terminalAt: 12 },
  };
  let row: object | null = {
    sessionId: 'session',
    seatId: 'reader',
    generation: 2,
    state: 'stopped',
    creationCompleted: true,
    physicalId: 'exact-old-id',
    sandboxName: 'exact-old-name',
    artifact: reference,
  };
  let retainedUnrelated = true;
  let revoked = false;
  let missingMember = false;
  let changedPolicy = false;
  const snapshot = vi.fn((_intent: unknown, action: () => void) => {
    if (revoked) throw Error('changed policy');
    action();
  });
  const input = {
    context: { owner: 'user', sessionId: 'session' },
    completion,
    events: {
      getActiveSymposiumConfig: () => ({
        revision: 5,
        seats: changedPolicy ? ['changed-grant'] : [],
      }),
      getSymposiumSeatSandbox: () => row,
      getSymposiumSealedReaderAdmission: () => ({
        reference,
        binding,
        receipt: { bindingDigest: artifactAdmissionDigest(binding) },
      }),
      getSymposiumArtifactSealByFence: (fence: string) => ({
        fenceId: fence,
        configDigest: createHash('sha256')
          .update(JSON.stringify({ revision: 2, seats: [] }))
          .digest('hex'),
        memberships: missingMember
          ? []
          : [
              {
                seatId: 'reader',
                generation: 2,
                state: 'active',
                reconciliation: 'confirmed',
                bindingDigest: createHash('sha256').update('{}').digest('hex'),
              },
            ],
        selection: {
          expectedConfigRevision: 2,
          sessionId: 'session',
          artifact: { volumeGeneration: fence === 'old' ? 'old-generation' : 'fresh-generation' },
        },
      }),
      getSymposiumMembershipHistory: () => [
        {
          seatId: 'reader',
          generation: 2,
          action: 'sealed_reader',
          state: 'active',
          reconciliation: 'confirmed',
          configRevision: 3,
          bindingKey: {},
        },
      ],
      withSymposiumHistoricalArtifactSealSnapshot: snapshot,
    },
    registry: { pending: () => [], pendingPreparations: () => [] },
    sourceResult: {
      artifactRevision: 'old-commit',
      artifactHash: 'old-hash',
      evidenceRefs: ['artifact-seal:old'],
      sealDigest: 'a'.repeat(64),
    },
    currentFence: 'fresh',
    retainedUnrelated: () => retainedUnrelated,
  } as unknown as Parameters<typeof hasCompletedReaderCleanupProof>[0];
  binding.sealDigest = createHash('sha256')
    .update(JSON.stringify(input.events.getSymposiumArtifactSealByFence('old')))
    .digest('hex');
  expect(hasCompletedReaderCleanupProof(input)).toBe(true);
  input.sourceResult!.sealDigest = 'different-physical-seal';
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  input.sourceResult!.sealDigest = 'a'.repeat(64);
  input.sourceResult!.evidenceRefs.push('artifact-seal:old');
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  input.sourceResult!.evidenceRefs.pop();
  const retainedSourceResult = input.sourceResult;
  input.sourceResult = null;
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  input.sourceResult = retainedSourceResult;
  missingMember = true;
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  missingMember = false;
  changedPolicy = true;
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  changedPolicy = false;
  retainedUnrelated = false;
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  retainedUnrelated = true;
  row = null;
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  row = {
    sessionId: 'session',
    seatId: 'reader',
    generation: 2,
    state: 'ready',
    artifact: reference,
  };
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  row = {
    sessionId: 'session',
    seatId: 'reader',
    generation: 2,
    state: 'stopped',
    creationCompleted: true,
    physicalId: 'exact-old-id',
    sandboxName: 'exact-old-name',
    artifact: { ...reference, sealFenceId: 'changed' },
  };
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
  row = {
    sessionId: 'session',
    seatId: 'reader',
    generation: 2,
    state: 'stopped',
    creationCompleted: true,
    physicalId: 'exact-old-id',
    sandboxName: 'exact-old-name',
    artifact: reference,
  };
  revoked = true;
  expect(hasCompletedReaderCleanupProof(input)).toBe(false);
});

it('recovers the original pending writer seal after process-local runtime loss and artifact-store reopen', async () => {
  await exerciseWriterSealRecovery(true, true);
});
