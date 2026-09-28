import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymposiumProductionReviewComposition } from '../symposium-production-review-composition.js';

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
    exportSuccessorArtifactBundle: vi.fn(),
    copySuccessorArtifact: vi.fn(),
    activateSuccessorArtifact: vi.fn(),
    admitSuccessorArtifact: vi.fn(),
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
    expect(composed.reviewHost.initialArtifact(context)).toEqual({
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
