import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_PUBLISH_MAX_BUNDLE_BYTES,
  createGithubPublishPrExecutor,
  githubRepositoryFromOrigin,
  type GithubHostPublisher,
  type GithubSandboxInspection,
} from '../connections/capabilities/github-publish-pr.js';
import type {
  CapabilityExecutionContext,
  CapabilityOperation,
} from '../connections/capabilities/types.js';

const operation: CapabilityOperation = {
  id: 'operation-1',
  connectionId: 'connection-1',
  connectionRevision: 2,
  capabilityId: 'github.publish-pr',
  capabilityVersion: 1,
  grantId: 'grant-1',
  accountId: 'account-1',
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  idempotencyKey: 'key-1',
  inputHash: 'hash',
  status: 'verification_pending',
  externalResultId: null,
  result: null,
  failureCode: null,
  createdAt: 1,
  updatedAt: 1,
};
const input = {
  connectionId: 'connection-1',
  repositoryPath: '/sandbox/workspaces/mgmt/repo',
  baseBranch: 'main',
  title: 'Publish work',
  body: 'Committed work',
  draft: false,
};
function inspection(overrides: Partial<GithubSandboxInspection> = {}): GithubSandboxInspection {
  return {
    canonicalRepositoryPath: input.repositoryPath,
    status: '',
    sourceBranch: 'feature/safe',
    defaultBranch: 'main',
    originUrl: 'https://github.com/acme/widgets.git',
    commitsAhead: 2,
    changedFiles: ['src/index.ts'],
    sourceBranchProtected: false,
    ...overrides,
  };
}
function context(overrides: Partial<CapabilityExecutionContext> = {}): CapabilityExecutionContext {
  return { operation, input, signal: new AbortController().signal, ...overrides };
}
function fixture(
  overrides: { inspection?: Partial<GithubSandboxInspection>; bundle?: Buffer } = {},
) {
  const sandbox = {
    inspect: vi.fn(async () => inspection(overrides.inspection)),
    exportBundle: vi.fn(async () => overrides.bundle ?? Buffer.from('bundle')),
  };
  const pull = {
    repository: 'acme/widgets',
    sourceBranch: 'feature/safe',
    baseBranch: 'main',
    url: 'https://github.com/acme/widgets/pull/12',
    id: '12',
  };
  const host: GithubHostPublisher = {
    reconstruct: vi.fn(async () => ({ directory: '/tmp/mitzo-github-publish-test' })),
    push: vi.fn(async () => {}),
    findOpen: vi.fn(async () => null),
    create: vi.fn(async () => pull),
    read: vi.fn(async () => pull),
    cleanup: vi.fn(async () => {}),
  };
  const executor = createGithubPublishPrExecutor({
    sandbox,
    host,
    resolveConversation: () => ({
      workspace: '/sandbox/workspaces/mgmt',
      sandboxName: 'sandbox-1',
    }),
    resolvePublicConfig: () => ({
      allowedRepositories: ['acme/widgets'],
      allowedBaseBranches: ['main'],
    }),
  });
  return { sandbox, host, pull, executor };
}

describe('github.publish-pr capability', () => {
  it('accepts only canonical GitHub origins', () => {
    expect(githubRepositoryFromOrigin('git@github.com:Acme/Widgets.git')).toBe('acme/widgets');
    expect(() => githubRepositoryFromOrigin('https://evil.test/acme/widgets.git')).toThrow(
      'not GitHub',
    );
  });
  it.each([
    ['dirty tree', { status: ' M src/index.ts' }, 'dirty'],
    ['detached HEAD', { sourceBranch: null }, 'detached'],
    ['default branch', { sourceBranch: 'main' }, 'protected'],
    ['protected branch', { sourceBranchProtected: true }, 'protected'],
    ['non GitHub origin', { originUrl: 'https://gitlab.com/acme/widgets.git' }, 'not GitHub'],
    ['source has no commits', { commitsAhead: 0 }, 'no commits'],
    [
      'canonical path drift',
      { canonicalRepositoryPath: '/sandbox/workspaces/mgmt/other' },
      'ambiguous',
    ],
  ])('fails closed for %s before export', async (_label, change, message) => {
    const f = fixture({ inspection: change });
    await expect(f.executor.execute(context())).rejects.toThrow(message);
    expect(f.sandbox.exportBundle).not.toHaveBeenCalled();
    expect(f.host.reconstruct).not.toHaveBeenCalled();
  });
  it('rejects traversal and connection allowlist changes before export', async () => {
    const f = fixture();
    await expect(
      f.executor.execute(
        context({ input: { ...input, repositoryPath: '/sandbox/workspaces/mgmt/../repo' } }),
      ),
    ).rejects.toThrow(/ambiguous|escapes/);
    const disallowed = createGithubPublishPrExecutor({
      sandbox: f.sandbox,
      host: f.host,
      resolveConversation: () => ({
        workspace: '/sandbox/workspaces/mgmt',
        sandboxName: 'sandbox-1',
      }),
      resolvePublicConfig: () => ({
        allowedRepositories: ['acme/other'],
        allowedBaseBranches: ['release'],
      }),
    });
    await expect(disallowed.execute(context())).rejects.toThrow('not allowed');
    expect(f.sandbox.exportBundle).not.toHaveBeenCalled();
  });
  it('bounds binary exports and cleans a reconstructed checkout after an apply conflict', async () => {
    const overflow = fixture({ bundle: Buffer.alloc(GITHUB_PUBLISH_MAX_BUNDLE_BYTES + 1) });
    await expect(overflow.executor.execute(context())).rejects.toThrow('exceeds');
    expect(overflow.host.reconstruct).not.toHaveBeenCalled();
    const conflict = fixture();
    vi.mocked(conflict.host.reconstruct).mockRejectedValueOnce(new Error('apply conflict'));
    await expect(conflict.executor.execute(context())).rejects.toThrow('apply conflict');
    const nonFastForward = fixture();
    vi.mocked(nonFastForward.host.push).mockRejectedValueOnce(new Error('non-fast-forward'));
    await expect(nonFastForward.executor.execute(context())).rejects.toThrow('non-fast-forward');
    expect(nonFastForward.host.cleanup).toHaveBeenCalledWith('/tmp/mitzo-github-publish-test');
  });
  it('creates, verifies, and reports a pull request without exposing credentials', async () => {
    const f = fixture();
    const result = await f.executor.execute(context());
    await f.executor.verify(
      context({ operation: { ...operation, externalResultId: result.externalResultId! } }),
      result,
    );
    expect(f.host.push).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'feature/safe', operationId: operation.id }),
    );
    expect(f.host.create).toHaveBeenCalledTimes(1);
    expect(f.host.read).toHaveBeenCalledWith(
      expect.objectContaining({ externalResultId: f.pull.url }),
    );
    expect(JSON.stringify(result)).not.toContain('token');
  });
  it('uses an existing open pull request rather than creating a duplicate', async () => {
    const f = fixture();
    vi.mocked(f.host.findOpen).mockResolvedValueOnce(f.pull);
    const result = await f.executor.execute(context());
    expect(result.externalResultId).toBe(f.pull.url);
    expect(f.host.create).not.toHaveBeenCalled();
  });
  it('rejects malformed create/read results and cancellation', async () => {
    const malformed = fixture();
    vi.mocked(malformed.host.create).mockResolvedValueOnce({
      ...malformed.pull,
      url: 'https://evil.test/pr/12',
    });
    await expect(malformed.executor.execute(context())).rejects.toThrow('invalid');
    const f = fixture();
    const result = await f.executor.execute(context());
    vi.mocked(f.host.read).mockResolvedValueOnce({ ...f.pull, baseBranch: 'other' });
    await expect(
      f.executor.verify(
        context({ operation: { ...operation, externalResultId: result.externalResultId! } }),
        result,
      ),
    ).rejects.toThrow('invalid');
    const controller = new AbortController();
    controller.abort();
    await expect(f.executor.execute(context({ signal: controller.signal }))).rejects.toThrow(
      /aborted|cancelled/i,
    );
  });
  it('recovers a duplicate retry by read-after-write only', async () => {
    const f = fixture();
    const recovered: CapabilityOperation = {
      ...operation,
      externalResultId: f.pull.url,
      result: {
        repository: f.pull.repository,
        sourceBranch: f.pull.sourceBranch,
        baseBranch: f.pull.baseBranch,
      },
    };
    await f.executor.recover(recovered, new AbortController().signal);
    expect(f.host.read).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: operation.id, externalResultId: f.pull.url }),
    );
    expect(f.host.push).not.toHaveBeenCalled();
    expect(f.host.create).not.toHaveBeenCalled();
  });
});
