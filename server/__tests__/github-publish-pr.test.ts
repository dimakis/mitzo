import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
  githubGitBoundaryScript,
  parseGithubPullRequest,
  GitHubCliHostPublisher,
} from '../connections/capabilities/github-publish-pr-transport.js';
import type {
  CapabilityExecutionContext,
  CapabilityOperation,
} from '../connections/capabilities/types.js';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';
import { CapabilityExecutorRegistry } from '../connections/capabilities/registry.js';
import { CapabilityService } from '../connections/capabilities/service.js';
import type { CapabilityTemplate } from '../connections/types.js';

const exec = promisify(execFile);

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
  it('uses the production service preflight card for approval, execution, and durable ambiguous recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mitzo-github-service-'));
    const f = fixture({ inspection: { changedFiles: ['deleted.ts', 'src/index.ts'] } });
    const capability: CapabilityTemplate = {
      id: 'github.publish-pr',
      version: 1,
      label: 'Publish pull request',
      description: 'test',
      connectionTemplates: [{ id: 'github-readonly', version: 1 }],
      executor: 'github-publish-pr-v1',
      approval: 'always',
      idempotency: 'required',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string', minLength: 1, maxLength: 128 },
          repositoryPath: { type: 'string', minLength: 1, maxLength: 256 },
          baseBranch: { type: 'string', minLength: 1, maxLength: 128 },
          title: { type: 'string', minLength: 1, maxLength: 128 },
          body: { type: 'string', maxLength: 512 },
          draft: { type: 'boolean' },
        },
        required: ['connectionId', 'repositoryPath', 'baseBranch', 'title', 'body', 'draft'],
        additionalProperties: false,
      },
    };
    const store = new CapabilityOperationStore(join(directory, 'operations.db'));
    const connection = {
      id: 'connection-1',
      templateId: 'github-readonly',
      templateVersion: 1,
      revision: 2,
      status: 'active',
      desiredAccountIds: ['account-1'],
    };
    store.upsertGrant({
      connectionId: connection.id,
      connectionRevision: connection.revision,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      accountIds: ['account-1'],
      status: 'active',
    });
    const approve = vi.fn(async () => true);
    const service = new CapabilityService({
      store,
      executorRegistry: new CapabilityExecutorRegistry({ 'github-publish-pr-v1': f.executor }),
      getTemplate: () => capability,
      getConnection: () => connection,
      listConnections: () => [connection],
      isConnectionActiveForConversation: () => true,
      approve,
    });
    const existing = { ...f.pull, id: '12', url: 'https://github.com/acme/widgets/pull/12' };
    vi.mocked(f.host.findOpen).mockResolvedValue(existing);
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const completed = await service.invoke(
        {
          capabilityId: capability.id,
          capabilityVersion: capability.version,
          connectionId: connection.id,
          connectionRevision: connection.revision,
          accountId: 'account-1',
          conversationId: 'conversation-1',
          turnId: 'turn-1',
          idempotencyKey: 'approved',
          input,
        },
        new AbortController().signal,
      );
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            repository: 'acme/widgets',
            sourceBranch: 'feature/safe',
            sourceOid: 'a'.repeat(40),
            commitCount: '2',
            changedFiles: '["deleted.ts","src/index.ts"]',
            existingPullRequest: 'update',
          }),
        }),
        expect.any(AbortSignal),
      );
      expect(completed).toMatchObject({ status: 'succeeded', recoveryIntent: expect.any(Object) });
      expect(f.host.update).toHaveBeenCalledTimes(1);

      vi.mocked(f.host.create).mockRejectedValueOnce(new Error('lost response'));
      vi.mocked(f.host.findOpen).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const ambiguous = await service.invoke(
        {
          capabilityId: capability.id,
          capabilityVersion: capability.version,
          connectionId: connection.id,
          connectionRevision: connection.revision,
          accountId: 'account-1',
          conversationId: 'conversation-1',
          turnId: 'turn-2',
          idempotencyKey: 'ambiguous',
          input,
        },
        new AbortController().signal,
      );
      expect(ambiguous).toMatchObject({
        status: 'verification_pending',
        recoveryIntent: expect.objectContaining({
          repository: 'acme/widgets',
          sourceOid: 'a'.repeat(40),
        }),
      });
      expect(store.get(ambiguous.id)?.recoveryIntent).toEqual(ambiguous.recoveryIntent);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await rm(directory, { recursive: true, force: true });
    }
  });

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
  it('evaluates rulesets for an unborn source branch before allowing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mitzo-fake-gh-'));
    const gh = join(directory, 'gh');
    await writeFile(
      gh,
      "#!/bin/sh\ncase \"$*\" in *'/rules/branches/feature%2Fsafe'*) printf '%s' '[]' ;; *'/branches/feature%2Fsafe'*) echo 'HTTP 404' >&2; exit 1 ;; *'repos/acme/widgets'*) printf '%s' '{\"default_branch\":\"main\",\"full_name\":\"Acme/Widgets\"}' ;; esac\n",
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
  it('fails closed when unborn-branch rules cannot be established or apply', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mitzo-fake-gh-'));
    const gh = join(directory, 'gh');
    await writeFile(
      gh,
      "#!/bin/sh\ncase \"$*\" in *'/rules/branches/feature%2Fsafe'*) printf '%s' '[{\"type\":\"pull_request\"}]' ;; *'/branches/feature%2Fsafe'*) echo 'HTTP 404' >&2; exit 1 ;; *'repos/acme/widgets'*) printf '%s' '{\"default_branch\":\"main\",\"full_name\":\"Acme/Widgets\"}' ;; esac\n",
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
      ).resolves.toEqual({ defaultBranch: 'main', sourceBranchProtected: true });
      await writeFile(
        gh,
        "#!/bin/sh\ncase \"$*\" in *'/branches/feature%2Fsafe'*|*'/rules/branches/feature%2Fsafe'*) echo 'HTTP 404' >&2; exit 1 ;; *'repos/acme/widgets'*) printf '%s' '{\"default_branch\":\"main\",\"full_name\":\"Acme/Widgets\"}' ;; esac\n",
        { mode: 0o700 },
      );
      await expect(
        new GitHubCliHostPublisher().policy({
          repository: 'acme/widgets',
          sourceBranch: 'feature/safe',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('cannot be established');
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
  it('fails closed instead of treating a malformed nonempty open lookup as createable', async () => {
    const runner = vi.fn(async () => ({ stdout: '[{}]', stderr: '' }));
    await expect(
      new GitHubCliHostPublisher(runner).findOpen({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        baseBranch: 'main',
        operationId: 'op',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('lookup is invalid');
  });
  it('uses an all-state head/base lookup when recovery has no PR URL', async () => {
    const runner = vi.fn(async (_command: string, _args: readonly string[]) => ({
      stdout: JSON.stringify([
        {
          number: 12,
          html_url: 'https://github.com/acme/widgets/pull/12',
          state: 'closed',
          merged: true,
          title: input.title,
          body: input.body,
          draft: input.draft,
          head: { ref: 'feature/safe' },
          base: { ref: 'main', repo: { full_name: 'acme/widgets' } },
        },
      ]),
      stderr: '',
    }));
    await expect(
      new GitHubCliHostPublisher(runner).read({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        baseBranch: 'main',
        operationId: 'op',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ id: '12', state: 'closed', merged: true });
    expect(runner).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['state=all', 'per_page=100']),
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
    const inputUrl = 'https://GitHub.com:443/Acme/Widgets/pull/12';
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
    { url: 'https://github.com/acme/widgets/pull/12?state=open' },
    { url: 'https://github.com/acme/widgets/pull/12#comment' },
    { url: 'https://user:password@github.com/acme/widgets/pull/12' },
    { url: 'https://github.com:444/acme/widgets/pull/12' },
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
  it.each([
    'https://github.com/acme/widgets/pull/12?state=open',
    'https://github.com/acme/widgets/pull/12#comment',
    'https://user:password@github.com/acme/widgets/pull/12',
    'https://github.com:444/acme/widgets/pull/12',
  ])('rejects impure PR read URLs before host GET', async (externalResultId) => {
    const runner = vi.fn();
    await expect(
      new GitHubCliHostPublisher(runner).read({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        baseBranch: 'main',
        externalResultId,
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
        : '{"default_branch":"main","full_name":"acme/widgets"}',
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
  it('fails closed on a GitHub rename or redirect before querying branch policy', async () => {
    const runner = vi.fn(async (_command: string, _args: readonly string[]) => ({
      stdout: '{"default_branch":"main","full_name":"acme/renamed"}',
      stderr: '',
    }));
    await expect(
      new GitHubCliHostPublisher(runner).policy({
        repository: 'acme/widgets',
        sourceBranch: 'feature/safe',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('GitHub repository policy is invalid');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1]).toEqual(expect.arrayContaining(['repos/acme/widgets']));
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
      if (joined.includes('diff-tree')) return 'src/index.ts\ndeleted.ts\nsrc/index.ts\n';
      return 'src/index.ts\n';
    });
    const transport = new OpenShellGithubSandboxTransport(run, 'mgmt');
    const inspected = await transport.inspect({
      sandboxName: 'sandbox-1',
      repositoryPath: input.repositoryPath,
      baseBranch: 'main',
      signal: new AbortController().signal,
    });
    expect(inspected).toMatchObject({
      sourceBranch: 'feature/safe',
      sourceOid: 'a'.repeat(40),
      changedFiles: ['deleted.ts', 'src/index.ts'],
    });
    for (const call of run.mock.calls) {
      const args = call[0] as readonly string[];
      expect(args).toContain('/bin/sh');
      const script = args[args.indexOf('-c') + 1] as string;
      expect(script).toContain('realpath');
      expect(script).toContain('cd -P');
      expect(script).toContain('--absolute-git-dir');
      expect(script).toContain('--git-common-dir');
      expect(script).toContain('[ ! -L "$repo/.git" ]');
      expect(script).toContain('exec /usr/bin/git');
    }
    expect(JSON.stringify(run.mock.calls)).not.toContain('refs/remotes/origin/HEAD');
    expect(
      run.mock.calls.find((call) => (call[0] as readonly string[]).includes('diff-tree'))?.[0],
    ).toEqual(
      expect.arrayContaining(['diff-tree', '--root', '--no-commit-id', '-r', '--name-only']),
    );
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
  it('rejects a symlinked git directory and a gitfile whose effective dir escapes the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mitzo-github-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'mitzo-github-outside-'));
    const repository = join(workspace, 'repo');
    try {
      await exec('git', ['init', '--quiet', repository]);
      const canonicalWorkspace = await realpath(workspace);
      const canonicalRepository = await realpath(repository);
      await expect(
        exec('/bin/sh', [
          '-c',
          githubGitBoundaryScript,
          'mitzo-github-git',
          canonicalWorkspace,
          canonicalRepository,
          'status',
          '--porcelain=v1',
        ]),
      ).resolves.toMatchObject({ stdout: '' });

      const internalGitDir = join(workspace, 'inside.git');
      await rename(join(repository, '.git'), internalGitDir);
      await symlink(internalGitDir, join(repository, '.git'));
      await expect(
        exec('/bin/sh', [
          '-c',
          githubGitBoundaryScript,
          'mitzo-github-git',
          canonicalWorkspace,
          canonicalRepository,
          'status',
        ]),
      ).rejects.toThrow();

      await rm(join(repository, '.git'));
      const externalGitDir = join(outside, 'gitdir');
      await rename(internalGitDir, externalGitDir);
      await writeFile(join(repository, '.git'), `gitdir: ${externalGitDir}\n`);
      await expect(
        exec('/bin/sh', [
          '-c',
          githubGitBoundaryScript,
          'mitzo-github-git',
          canonicalWorkspace,
          canonicalRepository,
          'status',
        ]),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('inspects a repository with an origin remote but no origin HEAD symbolic ref', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mitzo-github-no-origin-head-'));
    try {
      await exec('git', ['init', '--quiet', directory]);
      await exec('git', [
        '-C',
        directory,
        'remote',
        'add',
        'origin',
        'https://github.com/acme/widgets.git',
      ]);
      await expect(
        exec('git', ['-C', directory, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
      ).rejects.toThrow();
      const run = vi.fn(async (args: readonly string[]) => {
        const joined = args.join(' ');
        if (joined.includes('status --porcelain')) return '';
        if (joined.includes('symbolic-ref --quiet --short HEAD')) return 'feature/safe\n';
        if (joined.includes('rev-parse HEAD')) return `${'a'.repeat(40)}\n`;
        if (joined.includes('remote get-url origin'))
          return 'https://github.com/acme/widgets.git\n';
        if (joined.includes('rev-list --count')) return '1\n';
        return 'deleted.ts\n';
      });
      await expect(
        new OpenShellGithubSandboxTransport(run, 'mgmt').inspect({
          sandboxName: 'sandbox-1',
          repositoryPath: input.repositoryPath,
          baseBranch: 'main',
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ changedFiles: ['deleted.ts'], sourceBranch: 'feature/safe' });
      expect(JSON.stringify(run.mock.calls)).not.toContain('refs/remotes/origin/HEAD');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      existingPullRequestId: '',
      existingPullRequestUrl: '',
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
  it('verifies semantically equivalent mixed-case GitHub PR URLs', async () => {
    const f = fixture();
    const externalResultId = 'https://GitHub.com/Acme/Widgets/pull/12';
    await expect(
      f.executor.verify(context({ operation: { ...operation, externalResultId } }), {
        output: {},
        externalResultId,
      }),
    ).resolves.toBeUndefined();
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
  it('rejects a close/replace race after push rather than changing the approved target', async () => {
    const f = fixture();
    vi.mocked(f.host.findOpen)
      .mockResolvedValueOnce(f.pull)
      .mockResolvedValueOnce(f.pull)
      .mockResolvedValueOnce({
        ...f.pull,
        id: '13',
        url: 'https://github.com/acme/widgets/pull/13',
      });
    const preflight = await f.executor.preflight!(context());
    await expect(
      f.executor.execute(context({ approvalInput: preflight.approvalInput })),
    ).rejects.toThrow('changed after approval');
    expect(f.host.update).not.toHaveBeenCalled();
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
      recoveryIntent: {
        repository: f.pull.repository,
        sourceBranch: f.pull.sourceBranch,
        sourceOid: 'a'.repeat(40),
        baseBranch: f.pull.baseBranch,
        title: input.title,
        body: input.body,
        draft: input.draft,
        existingPullRequestId: '',
        existingPullRequestUrl: '',
      },
    };
    await expect(f.executor.recover(recovered, new AbortController().signal)).resolves.toEqual({
      outcome: 'verified',
    });
    expect(f.host.read).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: operation.id, externalResultId: f.pull.url }),
    );
    expect(f.host.push).not.toHaveBeenCalled();
    expect(f.host.create).not.toHaveBeenCalled();
  });
  it('recovers one authoritative head/base PR after metadata changes without another create', async () => {
    const f = fixture();
    vi.mocked(f.host.read).mockResolvedValueOnce({
      ...f.pull,
      title: 'Edited after the lost response',
      body: 'Different body',
      draft: true,
    });
    await expect(
      f.executor.recover(
        {
          ...operation,
          recoveryIntent: {
            repository: f.pull.repository,
            sourceBranch: f.pull.sourceBranch,
            sourceOid: 'a'.repeat(40),
            baseBranch: f.pull.baseBranch,
            title: input.title,
            body: input.body,
            draft: input.draft,
            existingPullRequestId: '',
            existingPullRequestUrl: '',
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'verified' });
    expect(f.host.create).not.toHaveBeenCalled();
    expect(f.host.update).not.toHaveBeenCalled();
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
            existingPullRequestId: mixed.id,
            existingPullRequestUrl: mixed.url,
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'verified' });
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
            existingPullRequestId: '',
            existingPullRequestUrl: '',
            operationId: operation.id,
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'verified' });
    expect(f.host.push).not.toHaveBeenCalled();
    expect(f.host.create).toHaveBeenCalledTimes(1);
  });
  it('recovers a matching closed PR from all states without creating or mutating it', async () => {
    const f = fixture();
    const closed = { ...f.pull, state: 'closed' as const, merged: true };
    vi.mocked(f.host.read).mockResolvedValue(closed);
    await expect(
      f.executor.recover(
        {
          ...operation,
          recoveryIntent: {
            repository: f.pull.repository,
            sourceBranch: f.pull.sourceBranch,
            sourceOid: 'a'.repeat(40),
            baseBranch: f.pull.baseBranch,
            title: input.title,
            body: input.body,
            draft: input.draft,
            existingPullRequestId: '',
            existingPullRequestUrl: '',
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: 'verified' });
    expect(f.host.read).toHaveBeenCalledWith(
      expect.objectContaining({ repository: f.pull.repository, sourceBranch: f.pull.sourceBranch }),
    );
    expect(f.host.create).not.toHaveBeenCalled();
    expect(f.host.update).not.toHaveBeenCalled();
  });
});
