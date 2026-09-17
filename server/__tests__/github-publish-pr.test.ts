import { Buffer } from 'node:buffer';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_PUBLISH_MAX_BUNDLE_BYTES,
  createGithubPublishPrExecutor,
  githubRepositoryFromOrigin,
  type GithubHostPublisher,
  type GithubSandboxInspection,
} from '../connections/capabilities/github-publish-pr.js';
import {
  OpenShellGithubSandboxTransport,
  parseGithubPullRequest,
  GitHubCliHostPublisher,
} from '../connections/capabilities/github-publish-pr-transport.js';
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
    sourceOid: 'a'.repeat(40),
    status: '',
    sourceBranch: 'feature/safe',
    defaultBranch: 'main',
    originUrl: 'https://github.com/acme/widgets.git',
    commitsAhead: 2,
    changedFiles: ['src/index.ts'],
    sourceBranchProtected: false,
    symlinkFree: true,
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
    title: input.title,
    body: input.body,
    draft: input.draft,
  };
  const host: GithubHostPublisher = {
    policy: vi.fn(async () => ({ defaultBranch: 'main', sourceBranchProtected: false })),
    reconstruct: vi.fn(async () => ({ directory: '/tmp/mitzo-github-publish-test' })),
    push: vi.fn(async () => {}),
    findOpen: vi.fn(async () => null),
    create: vi.fn(async () => pull),
    update: vi.fn(async () => pull),
    read: vi.fn(async () => pull),
    readBranch: vi.fn(async () => 'a'.repeat(40)),
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
  it('uses GitHub repository-local PR numbers rather than opaque database IDs', () => {
    expect(
      parseGithubPullRequest({
        id: 99887766,
        number: 12,
        html_url: 'https://github.com/acme/widgets/pull/12',
        state: 'closed',
        title: input.title,
        body: input.body,
        draft: false,
        head: { ref: 'feature/safe' },
        base: { ref: 'main', repo: { full_name: 'Acme/Widgets' } },
      }),
    ).toMatchObject({ id: '12', repository: 'acme/widgets' });
  });
  it('reads a known closed PR by its URL number instead of searching only open PRs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mitzo-fake-gh-'));
    const gh = join(directory, 'gh');
    const payload = JSON.stringify({
      id: 99887766,
      number: 12,
      html_url: 'https://github.com/acme/widgets/pull/12',
      state: 'closed',
      title: input.title,
      body: input.body,
      draft: false,
      head: { ref: 'feature/safe' },
      base: { ref: 'main', repo: { full_name: 'acme/widgets' } },
    });
    await writeFile(
      gh,
      `#!/bin/sh\ncase "$*" in *'repos/acme/widgets/pulls/12'*) printf '%s' '${payload}' ;; *) exit 1 ;; esac\n`,
      { mode: 0o700 },
    );
    await chmod(gh, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      await expect(
        new GitHubCliHostPublisher().read({
          repository: 'acme/widgets',
          sourceBranch: 'feature/safe',
          baseBranch: 'main',
          externalResultId: 'https://github.com/acme/widgets/pull/12',
          operationId: 'op',
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ id: '12', sourceBranch: 'feature/safe' });
    } finally {
      process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('treats only a GitHub branch 404 as an unprotected new source branch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mitzo-fake-gh-'));
    const gh = join(directory, 'gh');
    await writeFile(
      gh,
      "#!/bin/sh\ncase \"$*\" in *'/branches/feature/safe'*) echo 'HTTP 404' >&2; exit 1 ;; *'repos/acme/widgets'*) printf '%s' '{\"default_branch\":\"main\"}' ;; esac\n",
      { mode: 0o700 },
    );
    await chmod(gh, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      await expect(
        new GitHubCliHostPublisher().policy({
          repository: 'acme/widgets',
          sourceBranch: 'feature/safe',
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ defaultBranch: 'main', sourceBranchProtected: false });
    } finally {
      process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('queries only open PRs before create/update decisions', async () => {
    const runner = vi.fn(async () => ({ stdout: '[]', stderr: '' }));
    const found = await new GitHubCliHostPublisher(runner).findOpen({
      repository: 'acme/widgets',
      sourceBranch: 'feature/safe',
      baseBranch: 'main',
      operationId: 'op',
      signal: new AbortController().signal,
    });
    expect(found).toBeNull();
    expect(runner).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['state=open']),
      expect.any(AbortSignal),
    );
  });
  it.each([
    {
      currentDraft: true,
      requestedDraft: false,
      readiness: ['pr', 'ready', '12', '--repo', 'acme/widgets'],
    },
    {
      currentDraft: false,
      requestedDraft: true,
      readiness: ['pr', 'ready', '--undo', '12', '--repo', 'acme/widgets'],
    },
    { currentDraft: false, requestedDraft: false, readiness: undefined },
  ])(
    'uses the supported GitHub readiness transition for draft=$currentDraft -> $requestedDraft',
    async ({ currentDraft, requestedDraft, readiness }) => {
      const url = 'https://github.com/acme/widgets/pull/12';
      const response = (draft: boolean) =>
        JSON.stringify({
          id: 99,
          number: 12,
          html_url: url,
          title: input.title,
          body: input.body,
          draft,
          head: { ref: 'feature/safe' },
          base: { ref: 'main', repo: { full_name: 'acme/widgets' } },
        });
      const calls: string[][] = [];
      const runner = vi.fn(async (_command: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === 'pr') return { stdout: '', stderr: '' };
        return {
          stdout: response(args.includes('PATCH') ? currentDraft : requestedDraft),
          stderr: '',
        };
      });
      const updated = await new GitHubCliHostPublisher(runner).update({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        baseBranch: 'main',
        pullRequest: {
          repository: 'acme/widgets',
          sourceBranch: 'feature/safe',
          baseBranch: 'main',
          url,
          id: '12',
          title: input.title,
          body: input.body,
          draft: currentDraft,
        },
        title: input.title,
        body: input.body,
        draft: requestedDraft,
        operationId: 'op',
        signal: new AbortController().signal,
      });
      expect(updated.draft).toBe(requestedDraft);
      const patch = calls.find((args) => args.includes('PATCH'))!;
      expect(patch.join(' ')).not.toContain('draft=');
      if (readiness) expect(calls).toContainEqual(readiness);
      else expect(calls.some((args) => args[0] === 'pr')).toBe(false);
    },
  );
  it('preserves a validated mixed-case PR URL for exact re-read', async () => {
    const inputUrl = 'https://GitHub.com/Acme/Widgets/pull/12';
    const apiUrl = 'https://github.com/acme/widgets/pull/12';
    const payload = JSON.stringify({
      id: 1,
      number: 12,
      html_url: apiUrl,
      title: input.title,
      body: input.body,
      draft: false,
      head: { ref: 'feature/safe' },
      base: { ref: 'main', repo: { full_name: 'Acme/Widgets' } },
    });
    const runner = vi.fn(async () => ({ stdout: payload, stderr: '' }));
    await expect(
      new GitHubCliHostPublisher(runner).update({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        baseBranch: 'main',
        pullRequest: {
          repository: 'Acme/Widgets',
          sourceBranch: 'feature/safe',
          baseBranch: 'main',
          url: inputUrl,
          id: '12',
          title: input.title,
          body: input.body,
          draft: false,
        },
        title: input.title,
        body: input.body,
        draft: false,
        operationId: 'op',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ id: '12' });
  });
  it.each([
    { url: 'https://evil.test/acme/widgets/pull/12' },
    { repository: 'evil/widgets' },
    { id: '99', url: 'https://github.com/acme/widgets/pull/12' },
  ])('rejects hostile existing PR identity before PATCH or readiness mutation', async (hostile) => {
    const runner = vi.fn();
    await expect(
      new GitHubCliHostPublisher(runner).update({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        baseBranch: 'main',
        pullRequest: {
          repository: 'acme/widgets',
          sourceBranch: 'feature/safe',
          baseBranch: 'main',
          url: 'https://github.com/acme/widgets/pull/12',
          id: '12',
          title: input.title,
          body: input.body,
          draft: true,
          ...hostile,
        },
        title: input.title,
        body: input.body,
        draft: false,
        operationId: 'op',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid');
    expect(runner).not.toHaveBeenCalled();
  });
  it('honors authoritative protection when the source branch already exists', async () => {
    const runner = vi.fn(async (_command: string, args: readonly string[]) => ({
      stdout: args.at(-1)?.includes('/branches/')
        ? '{"protected":true}'
        : '{"default_branch":"main"}',
      stderr: '',
    }));
    await expect(
      new GitHubCliHostPublisher(runner).policy({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ defaultBranch: 'main', sourceBranchProtected: true });
  });
  it('reconstructs through an empty checkout sibling and removes only its tracked parent', async () => {
    const oid = 'a'.repeat(40);
    const calls: string[][] = [];
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'clone') await mkdir(args.at(-1)!, { recursive: true, mode: 0o700 });
      if (args.includes('rev-parse')) return { stdout: `${oid}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const publisher = new GitHubCliHostPublisher(runner);
    const rebuilt = await publisher.reconstruct({
      repository: 'acme/widgets',
      sourceBranch: 'feature/safe',
      sourceOid: oid,
      baseBranch: 'main',
      bundle: Buffer.from('bundle'),
      operationId: 'operation-1',
      signal: new AbortController().signal,
    });
    const clone = calls.find((args) => args[0] === 'clone')!;
    const fetch = calls.find((args) => args.includes('fetch'))!;
    const bundlePath = fetch.find((value) => value.endsWith('/commits.bundle'))!;
    expect(clone.at(-1)).toMatch(/\/checkout$/);
    expect(bundlePath).toMatch(/\/commits\.bundle$/);
    expect(bundlePath).not.toBe(clone.at(-1));
    expect(JSON.stringify(calls)).not.toContain('SENTINEL_TOKEN');
    await expect(stat(bundlePath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await publisher.cleanup(rebuilt.cleanupDirectory!);
    await expect(stat(rebuilt.cleanupDirectory!)).rejects.toThrow();
  });
  it('binds sandbox path validation and every Git action in one control invocation', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      const joined = args.join(' ');
      if (joined.includes('status --porcelain')) return '';
      if (joined.includes('symbolic-ref --quiet --short HEAD')) return 'feature/safe\n';
      if (joined.includes('rev-parse HEAD')) return `${'a'.repeat(40)}\n`;
      if (joined.includes('remote get-url origin')) return 'https://github.com/acme/widgets.git\n';
      if (joined.includes('rev-list --count')) return '1\n';
      if (joined.includes('refs/remotes/origin/HEAD')) return 'origin/main\n';
      return 'src/index.ts\n';
    });
    const transport = new OpenShellGithubSandboxTransport(run, 'mgmt');
    const inspected = await transport.inspect({
      sandboxName: 'sandbox-1',
      repositoryPath: input.repositoryPath,
      baseBranch: 'main',
      signal: new AbortController().signal,
    });
    expect(inspected).toMatchObject({ sourceBranch: 'feature/safe', sourceOid: 'a'.repeat(40) });
    for (const call of run.mock.calls) {
      const args = call[0] as readonly string[];
      expect(args).toContain('/bin/sh');
      const script = args[args.indexOf('-c') + 1] as string;
      expect(script).toContain('realpath -e');
      expect(script).toContain('cd -P');
      expect(script).toContain('exec /usr/bin/git');
    }
    run.mockClear();
    run.mockResolvedValueOnce('YnVuZGxl');
    await transport.exportBundle({
      sandboxName: 'sandbox-1',
      repositoryPath: input.repositoryPath,
      sourceBranch: 'feature/safe',
      sourceOid: 'a'.repeat(40),
      baseBranch: 'main',
      maxBytes: 1024,
      signal: new AbortController().signal,
    });
    const exportArgs = run.mock.calls[0]![0] as readonly string[];
    expect(exportArgs).toContain('a'.repeat(40));
    expect(exportArgs[exportArgs.indexOf('-c') + 1]).toContain('rev-parse HEAD');
  });
  it('accepts only canonical GitHub origins', () => {
    expect(githubRepositoryFromOrigin('git@github.com:Acme/Widgets.git')).toBe('acme/widgets');
    expect(() => githubRepositoryFromOrigin('https://evil.test/acme/widgets.git')).toThrow(
      'not GitHub',
    );
  });
  it('allows the trusted workspace itself when it is the repository', async () => {
    const f = fixture();
    vi.mocked(f.sandbox.inspect).mockResolvedValue(
      inspection({ canonicalRepositoryPath: '/sandbox/workspaces/mgmt' }),
    );
    const result = await f.executor.execute(
      context({ input: { ...input, repositoryPath: '/sandbox/workspaces/mgmt' } }),
    );
    expect(result.externalResultId).toBe(f.pull.url);
  });
  it('accepts mixed-case GitHub HTML URLs for the verified repository', async () => {
    const f = fixture();
    vi.mocked(f.host.create).mockResolvedValueOnce({
      ...f.pull,
      repository: 'Acme/Widgets',
      url: 'https://GitHub.com/Acme/Widgets/pull/12',
    });
    await expect(f.executor.execute(context())).resolves.toMatchObject({
      externalResultId: 'https://GitHub.com/Acme/Widgets/pull/12',
    });
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
  it('renders the complete trusted preflight card and fails closed when it changes after approval', async () => {
    const f = fixture();
    const preflight = await f.executor.preflight!(context());
    expect(preflight.approvalInput).toMatchObject({
      ...input,
      repository: 'acme/widgets',
      sourceBranch: 'feature/safe',
      baseBranch: 'main',
      commitCount: '2',
      changedFiles: '["src/index.ts"]',
      existingPullRequest: 'create',
    });
    await expect(
      f.executor.execute(
        context({ approvalInput: { ...preflight.approvalInput, commitCount: '1' } }),
      ),
    ).rejects.toThrow('changed after approval');
    expect(f.sandbox.exportBundle).not.toHaveBeenCalled();
  });
  it('binds the exact approved source OID and rejects approval-card overflow before export', async () => {
    const f = fixture();
    const preflight = await f.executor.preflight!(context());
    vi.mocked(f.sandbox.inspect).mockResolvedValueOnce(inspection({ sourceOid: 'b'.repeat(40) }));
    await expect(
      f.executor.execute(context({ approvalInput: preflight.approvalInput })),
    ).rejects.toThrow('changed after approval');
    const many = fixture({
      inspection: { changedFiles: Array.from({ length: 65 }, (_, i) => `src/${i}`) },
    });
    await expect(many.executor.preflight!(context())).rejects.toThrow('summary');
    expect(many.sandbox.exportBundle).not.toHaveBeenCalled();
  });
  it('rejects changed-file text that cannot fit the exact permission card serialization', async () => {
    const hostile = Array.from({ length: 64 }, () => '\\"'.repeat(60));
    const f = fixture({ inspection: { changedFiles: hostile } });
    await expect(f.executor.preflight!(context())).rejects.toThrow('complete approval projection');
    expect(f.sandbox.exportBundle).not.toHaveBeenCalled();
  });
  it('uses host-authoritative default and protection policy before any export', async () => {
    const f = fixture();
    vi.mocked(f.host.policy).mockResolvedValueOnce({
      defaultBranch: 'trunk',
      sourceBranchProtected: false,
    });
    vi.mocked(f.sandbox.inspect).mockResolvedValueOnce(inspection({ sourceBranch: 'trunk' }));
    await expect(f.executor.execute(context())).rejects.toThrow('protected');
    const protectedSource = fixture();
    vi.mocked(protectedSource.host.policy).mockResolvedValueOnce({
      defaultBranch: 'main',
      sourceBranchProtected: true,
    });
    await expect(protectedSource.executor.execute(context())).rejects.toThrow('protected');
  });
  it.each([
    ['reviewed protected pattern', { sourceBranch: 'release/4.0' }, 'protected'],
    ['symlink component', { symlinkFree: false }, 'ambiguous'],
  ])('fails before export for %s', async (_label, changed, message) => {
    const f = fixture({ inspection: changed });
    await expect(f.executor.execute(context())).rejects.toThrow(message);
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
  it('updates an existing open pull request with the approved metadata', async () => {
    const f = fixture();
    vi.mocked(f.host.findOpen).mockResolvedValue(f.pull);
    const result = await f.executor.execute(context());
    expect(result.externalResultId).toBe(f.pull.url);
    expect(f.host.create).not.toHaveBeenCalled();
    expect(f.host.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequest: expect.objectContaining({ id: '12' }),
        title: input.title,
        body: input.body,
        draft: false,
      }),
    );
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
      recoveryIntent: {
        repository: f.pull.repository,
        sourceBranch: f.pull.sourceBranch,
        sourceOid: 'a'.repeat(40),
        baseBranch: f.pull.baseBranch,
        title: input.title,
        body: input.body,
        draft: input.draft,
      },
    };
    await expect(
      f.executor.recover(recovered, new AbortController().signal),
    ).resolves.toMatchObject({
      externalResultId: f.pull.url,
    });
    expect(f.host.read).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: operation.id, externalResultId: f.pull.url }),
    );
    expect(f.host.push).not.toHaveBeenCalled();
    expect(f.host.create).not.toHaveBeenCalled();
  });
  it('recovers a mixed-case existing PR identity without treating it as a mismatch', async () => {
    const f = fixture();
    const mixed = {
      ...f.pull,
      repository: 'Acme/Widgets',
      url: 'https://GitHub.com/Acme/Widgets/pull/12',
    };
    vi.mocked(f.host.read).mockResolvedValue(mixed);
    vi.mocked(f.host.update).mockResolvedValue(mixed);
    await expect(
      f.executor.recover(
        {
          ...operation,
          externalResultId: mixed.url,
          recoveryIntent: {
            repository: 'acme/widgets',
            sourceBranch: 'feature/safe',
            sourceOid: 'a'.repeat(40),
            baseBranch: 'main',
            title: input.title,
            body: input.body,
            draft: false,
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ externalResultId: mixed.url });
  });
  it('recreates a missing PR only after the durable branch OID is verified', async () => {
    const f = fixture();
    vi.mocked(f.host.read).mockResolvedValueOnce(null);
    await expect(
      f.executor.recover(
        {
          ...operation,
          recoveryIntent: {
            repository: 'acme/widgets',
            sourceBranch: 'feature/safe',
            sourceOid: 'a'.repeat(40),
            baseBranch: 'main',
            title: input.title,
            body: input.body,
            draft: false,
            operationId: operation.id,
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ externalResultId: f.pull.url });
    expect(f.host.push).not.toHaveBeenCalled();
    expect(f.host.create).toHaveBeenCalledTimes(1);
  });
});
