import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactAdmissionDigest } from '@mitzo/protocol/event-store';
import {
  createSymposiumProductionReviewComposition,
  historicalFixPointer,
  historicalSealedResultCoderGeneration,
} from '../symposium-production-review-composition.js';

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
