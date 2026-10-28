import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  createGithubArtifactPublishPrExecutor,
  type GithubArtifactPublishDependencies,
  type GithubPublicationReview,
  type GithubPublicationReviewInput,
  type GithubSandboxInspection,
} from '../connections/capabilities/github-publish-pr.js';
import type {
  CapabilityExecutionContext,
  CapabilityOperation,
} from '../connections/capabilities/types.js';

const operation = {
  id: 'reviewed-operation',
  accountId: 'original-account',
  conversationId: 'original-conversation',
  connectionId: 'connection',
  connectionRevision: 1,
} as CapabilityOperation;
const input = {
  connectionId: 'connection',
  repositoryPath: '/task',
  baseBranch: 'main',
  title: 'Reviewed change',
  body: 'Prepared work',
  draft: true,
};
function fixture() {
  const order: string[] = [];
  const inspection: GithubSandboxInspection = {
    canonicalRepositoryPath: '/task',
    status: '',
    sourceBranch: 'feature/reviewed',
    sourceOid: 'a'.repeat(40),
    defaultBranch: 'main',
    originUrl: 'https://github.com/example/repo.git',
    commitsAhead: 1,
    changedFiles: ['change.ts'],
    sourceBranchProtected: false,
    symlinkFree: true,
  };
  const bundle = Buffer.from('frozen committed bundle');
  const pull = {
    repository: 'example/repo',
    sourceBranch: inspection.sourceBranch!,
    baseBranch: 'main',
    url: 'https://github.com/example/repo/pull/1',
    id: '1',
    title: input.title,
    body: input.body,
    draft: true,
  };
  const assertCurrent = vi.fn(async (evidence: GithubPublicationReviewInput) => {
    order.push('review-fence');
    // Production compares semantic Git evidence, not pack encoding. This
    // synthetic reviewer uses its deterministic bytes as the evidence stand-in.
    if (!evidence.bundle.equals(bundle)) throw Error('Reviewed Git evidence changed');
  });
  const review: GithubPublicationReview = vi.fn(async () => {
    order.push('review');
    return {
      receiptId: 'trusted-review-receipt',
      evidenceSha256: 'b'.repeat(64),
      summary: 'Two independent scopes approved the complete evidence.',
      assertCurrent,
    };
  });
  const deps: GithubArtifactPublishDependencies = {
    reviewCommittedChange: review,
    resolveWorkspace: () => '/task',
    resolvePublicConfig: () => ({
      allowedRepositories: ['example/repo'],
      allowedBaseBranches: ['main'],
    }),
    inspect: vi.fn(async () => structuredClone(inspection)),
    exportBundle: vi.fn(async () => Buffer.from(bundle)),
    host: {
      policy: vi.fn(async () => ({ defaultBranch: 'main', sourceBranchProtected: false })),
      reconstruct: vi.fn(async () => {
        order.push('reconstruct');
        return { directory: '/private/publication', cleanupDirectory: '/private/owner' };
      }),
      cleanup: vi.fn(async () => {
        order.push('cleanup');
      }),
      push: vi.fn(async () => {
        order.push('push');
      }),
      findOpen: vi.fn(async () => null),
      create: vi.fn(async () => pull),
      update: vi.fn(async () => pull),
      read: vi.fn(async () => pull),
      readBranch: vi.fn(async () => inspection.sourceOid),
    },
  };
  const context: CapabilityExecutionContext = {
    operation,
    input,
    signal: new AbortController().signal,
  };
  const executor = createGithubArtifactPublishPrExecutor(deps);
  return { deps, executor, context, review, assertCurrent, inspection, bundle, order };
}

it('reviews the frozen host artifact before approval and revalidates the private receipt before push', async () => {
  const f = fixture();
  const preflight = await f.executor.preflight!(f.context);
  expect(f.order).toEqual(['reconstruct', 'review', 'review-fence', 'cleanup']);
  expect(f.review).toHaveBeenCalledWith(
    expect.objectContaining({
      operation,
      repository: 'example/repo',
      sourceBranch: 'feature/reviewed',
      sourceOid: 'a'.repeat(40),
      baseBranch: 'main',
      directory: '/private/publication',
      bundle: f.bundle,
    }),
  );
  expect(preflight.approvalInput).toMatchObject({
    reviewReceiptId: 'trusted-review-receipt',
    reviewEvidenceSha256: 'b'.repeat(64),
    reviewSummary: 'Two independent scopes approved the complete evidence.',
  });
  expect(f.deps.host.push).not.toHaveBeenCalled();
  const published = await f.executor.execute({
    ...f.context,
    approvalInput: preflight.approvalInput,
  });
  expect(published.output).toMatchObject({
    review: { receiptId: 'trusted-review-receipt', evidenceSha256: 'b'.repeat(64) },
  });
  expect(f.review).toHaveBeenCalledTimes(1);
  expect(f.assertCurrent).toHaveBeenCalledTimes(2);
  expect(f.order.indexOf('push')).toBeGreaterThan(f.order.lastIndexOf('review-fence'));
  expect(f.deps.host.cleanup).toHaveBeenCalledTimes(2);
});

it('stops before approval and publication when independent review fails, preserving host cleanup', async () => {
  const f = fixture();
  vi.mocked(f.review).mockRejectedValue(Error('Review has blocking findings'));
  await expect(f.executor.preflight!(f.context)).rejects.toThrow('blocking findings');
  expect(f.deps.host.cleanup).toHaveBeenCalledOnce();
  expect(f.deps.host.push).not.toHaveBeenCalled();
});

it.each(['head', 'bundle', 'approval'])(
  'refuses a changed %s after review without publishing',
  async (changed) => {
    const f = fixture();
    const preflight = await f.executor.preflight!(f.context);
    if (changed === 'head') f.inspection.sourceOid = 'c'.repeat(40);
    if (changed === 'bundle')
      vi.mocked(f.deps.exportBundle).mockResolvedValue(Buffer.from('changed'));
    const approvalInput = { ...preflight.approvalInput };
    if (changed === 'approval') approvalInput.reviewReceiptId = 'model-invented-receipt';
    await expect(f.executor.execute({ ...f.context, approvalInput })).rejects.toThrow();
    expect(f.deps.host.push).not.toHaveBeenCalled();
  },
);

it('does not treat durable approval data as a private review receipt after a restart', async () => {
  const f = fixture();
  const preflight = await f.executor.preflight!(f.context);
  const replacement = createGithubArtifactPublishPrExecutor(f.deps);
  await expect(
    replacement.execute({ ...f.context, approvalInput: preflight.approvalInput }),
  ).rejects.toThrow(/review/i);
  expect(f.deps.host.push).not.toHaveBeenCalled();
  // Capability recovery, rather than execute, remains the only path for an
  // uncertain operation. A new publication must obtain another actual review.
  expect(f.review).toHaveBeenCalledTimes(1);
});

it('requires the actual approved action projection even outside production', async () => {
  const f = fixture();
  await f.executor.preflight!(f.context);
  await expect(f.executor.execute(f.context)).rejects.toThrow(/approval/i);
  expect(f.deps.host.push).not.toHaveBeenCalled();
});

it('checks revoked review authority against the reconstructed artifact immediately before effects', async () => {
  const f = fixture();
  const preflight = await f.executor.preflight!(f.context);
  f.assertCurrent.mockRejectedValue(Error('Original reviewer authority revoked'));
  await expect(
    f.executor.execute({ ...f.context, approvalInput: preflight.approvalInput }),
  ).rejects.toThrow(/revoked/);
  expect(f.deps.host.push).not.toHaveBeenCalled();
  expect(f.deps.host.cleanup).toHaveBeenCalledTimes(2);
});

it('rejects unbounded or invalid review metadata instead of treating it as approval', async () => {
  const f = fixture();
  vi.mocked(f.review).mockResolvedValue({
    receiptId: 'trusted',
    evidenceSha256: 'not-a-hash',
    summary: 'approved',
    assertCurrent: f.assertCurrent,
  });
  await expect(f.executor.preflight!(f.context)).rejects.toThrow(/review/i);
  expect(f.deps.host.push).not.toHaveBeenCalled();
});

it('does not accept evidence that fails the reviewer private semantic verification', async () => {
  const f = fixture();
  vi.mocked(f.review).mockImplementation(async (request) => {
    request.bundle.fill(0);
    return {
      receiptId: 'trusted',
      evidenceSha256: createHash('sha256').update('reviewed').digest('hex'),
      summary: 'Approved',
      assertCurrent: f.assertCurrent,
    };
  });
  await expect(f.executor.preflight!(f.context)).rejects.toThrow(/review/i);
  expect(f.deps.host.push).not.toHaveBeenCalled();
});

it('never creates a missing PR while recovering an uncertain reviewed publication', async () => {
  const f = fixture();
  const preflight = await f.executor.preflight!(f.context);
  vi.mocked(f.deps.host.read).mockResolvedValue(null);
  await expect(
    f.executor.recover(
      {
        ...operation,
        recoveryIntent: preflight.recoveryIntent!,
        externalResultId: null,
      },
      f.context.signal,
    ),
  ).rejects.toThrow(/pending/i);
  expect(f.deps.host.create).not.toHaveBeenCalled();
  expect(f.deps.host.push).not.toHaveBeenCalled();
});
