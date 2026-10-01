import { expect, it, vi } from 'vitest';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import {
  completedPublicationArtifact,
  completedSealHash,
  publicationSealFenceForRecord,
} from '../symposium-publication-artifact.js';
import type { CompletedArtifactSeal } from '../symposium-physical-artifact-seal.js';
import type { ImmutableReviewRecord } from '../symposium-review-workflows.js';
const store = new SymposiumReviewStore(':memory:');

it('selects the final fix seal from immutable verified history instead of an ambiguous session seal', () => {
  const result = (resultId: string, revision: string, fenceId: string) => ({
    version: 1 as const,
    resultId,
    attemptId: `${resultId}-attempt`,
    inputRevision: 'parent',
    inputHash: 'a'.repeat(64),
    artifactRevision: revision,
    artifactHash: 'b'.repeat(64),
    summary: 'Physically sealed result',
    evidenceRefs: [`artifact-seal:${fenceId}`],
    completedAt: 1,
  });
  const record = {
    snapshot: {
      artifactRevision: 'final-commit',
      artifactHash: 'b'.repeat(64),
      workflow: { currentResultId: 'fix-result' },
      history: [
        {
          action: 'initial_result_recorded',
          detail: { result: result('initial-result', 'initial-commit', 'initial-fence') },
        },
        {
          action: 'fix_recorded',
          detail: { result: result('fix-result', 'final-commit', 'final-fence') },
        },
      ],
    },
  } as ImmutableReviewRecord;
  expect(publicationSealFenceForRecord(record)).toBe('final-fence');
  expect(() =>
    publicationSealFenceForRecord({
      ...record,
      snapshot: {
        ...record.snapshot,
        history: [...record.snapshot.history, record.snapshot.history[1]],
      },
    }),
  ).toThrow('Exact verified result seal unavailable');
});

const scope = {
  owner: 'user',
  sessionId: 'session',
  workflowId: 'flow',
  artifactRevision: 'commit',
  artifactHash: 'b'.repeat(64),
};
const evidence = {
  version: 1 as const,
  evidenceId: 'check',
  resultId: 'result',
  criterion: 'works',
  artifactRevision: 'commit',
  verdict: 'verified' as const,
  evidenceRefs: ['test:1'],
  checkedAt: 1,
};
function verified(owner = 'user') {
  const seat = (id: string) => ({
    seatId: id,
    role: id,
    selectionId: id,
    policyRevision: 'p',
    profileId: id,
    profileRevision: 1,
    accountId: id,
    model: 'mock',
  });
  store.create({
    workflowId: 'flow',
    owner,
    sessionId: 'session',
    implementation: {
      version: 1,
      resultId: 'result',
      attemptId: 'build',
      inputRevision: 'input',
      inputHash: 'a'.repeat(64),
      artifactRevision: 'commit',
      artifactHash: scope.artifactHash,
      summary: 'Implemented',
      evidenceRefs: ['commit'],
      completedAt: 1,
    },
    implementer: seat('coder'),
    reviewer: seat('reviewer'),
    acceptanceCriteria: ['works'],
    limits: { maxReviewRounds: 3, maxTokens: 100, maxCostUsd: 1 },
  });
  store.admitAttempt({
    workflowId: 'flow',
    attemptId: 'review',
    enforcementId: 'cap',
    kind: 'review',
    actorSeatId: 'reviewer',
    artifactRevision: 'commit',
    artifactHash: scope.artifactHash,
    maxTokens: 10,
    maxCostUsd: 0.1,
  });
  store.recordReview({
    workflowId: 'flow',
    reviewId: 'review',
    reviewerSeatId: 'reviewer',
    kind: 'full',
    artifactRevision: 'commit',
    artifactHash: scope.artifactHash,
    findings: [],
    resolvedFingerprints: [],
    usage: { attemptId: 'review', tokens: 1, costUsd: 0.01 },
  });
  store.recordEvidence('flow', evidence, scope.artifactHash, 'host');
  expect(store.finalize('flow').kind).toBe('verified');
}
it('binds a real SQLite review record to a completed seal without a writer lease', async () => {
  verified();
  const record = store.exportVerifiedRecord(scope);
  const seal: CompletedArtifactSeal = {
    kind: 'completed_artifact_seal',
    version: 1,
    fenceId: 'fence',
    sessionId: 'session',
    custodyDigest: 'custody',
    intentDigest: 'intent',
    retentionDigest: 'retention',
    revocationDigest: 'revoked',
    repositoryPath: '.',
    git: {
      version: 1,
      commit: 'commit',
      tree: 'tree',
      entries: 1,
      bytes: 1,
      manifestDigest: 'manifest',
      committedTreeDigest: scope.artifactHash,
    },
    verifier: { id: 'gone', image: 'pinned', codeDigest: 'code' },
    completedAt: 1,
  };
  const requireCompletedArtifactSeal = vi.fn(async () => seal);
  const adapter = completedPublicationArtifact({
    store,
    host: {
      requireCompletedArtifactSeal,
      inspectCompletedArtifact: vi.fn(),
      exportCompletedArtifactBundle: vi.fn(),
    },
  });
  const selected = {
    operatorId: 'auth-session',
    sessionId: 'session',
    recordId: record.recordId,
    recordHash: record.contentHash,
    sealId: 'fence',
    sealHash: completedSealHash(seal),
    repository: 'owner/repo',
    connectionId: 'selected',
    connectionRevision: 1,
    credentialGeneration: 'generation',
  };
  expect(await adapter.require(selected, new AbortController().signal)).toEqual({
    workspace: '/sandbox/workspaces/mgmt',
    repositoryPath: '/sandbox/workspaces/mgmt',
    sourceOid: 'commit',
  });
  await expect(
    adapter.require({ ...selected, sealHash: 'c'.repeat(64) }, new AbortController().signal),
  ).rejects.toThrow();
  seal.repositoryPath = 'nested/repository';
  expect(
    await adapter.require(
      { ...selected, sealHash: completedSealHash(seal) },
      new AbortController().signal,
    ),
  ).toMatchObject({ repositoryPath: '/sandbox/workspaces/mgmt/nested/repository' });
  seal.repositoryPath = '../escape';
  await expect(
    adapter.require(
      { ...selected, sealHash: completedSealHash(seal) },
      new AbortController().signal,
    ),
  ).rejects.toThrow('binding');
  seal.repositoryPath = '.';
  store.recordEvidence(
    'flow',
    { ...evidence, evidenceId: 'changed', checkedAt: 2 },
    scope.artifactHash,
    'host',
  );
  await expect(adapter.require(selected, new AbortController().signal)).rejects.toThrow('current');
  store.close();
});
it('projects only the physical completed inspection clean marker into Git porcelain semantics', async () => {
  const inspection = {
    canonicalRepositoryPath: '/sandbox/workspaces/mgmt',
    status: 'clean',
    sourceBranch: 'feature',
    sourceOid: 'a'.repeat(40),
    defaultBranch: 'main',
    originUrl: 'https://github.com/example/project.git',
    commitsAhead: 1,
    changedFiles: ['criterion.txt'],
    sourceBranchProtected: false,
    symlinkFree: true,
  };
  const inspectCompletedArtifact = vi.fn(async () => inspection);
  const adapter = completedPublicationArtifact({
    store,
    host: {
      requireCompletedArtifactSeal: async () => {
        throw Error('Unused binding helper');
      },
      inspectCompletedArtifact,
      exportCompletedArtifactBundle: async () => {
        throw Error('Publication mutation forbidden');
      },
    },
  });
  const input = { fenceId: 'exact-seal', operationId: 'exact-preparation', baseBranch: 'main' };
  const signal = new AbortController().signal;
  expect(await adapter.inspectCompletedArtifact(input, signal)).toEqual({
    ...inspection,
    status: '',
  });
  expect(inspectCompletedArtifact).toHaveBeenCalledWith(input, signal);
  inspection.status = ' M criterion.txt';
  expect((await adapter.inspectCompletedArtifact(input, signal)).status).toBe(' M criterion.txt');
});
