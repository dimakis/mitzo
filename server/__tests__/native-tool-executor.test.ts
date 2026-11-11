import { callbackOutcome, retainCallbackOutcome, TurnCallbacks } from '../turn-callbacks.js';
import { executeTaskOperation } from '../task-execution-operation.js';
import { TaskExecutionStore } from '../task-execution-store.js';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { loadAccountProfiles } from '../account-profiles.js';
import { executeSandboxedCommand } from '../sandboxed-command.js';
import * as nativeFiles from '../native-file-operation.js';
import { executeTrustedGitCommit, executeTrustedGitHubRead } from '../trusted-native-operation.js';
import { executePublicGitHubRead } from '../public-github-read.js';
import { captureLocalRepository } from '../local-repository-worktree.js';
import { snapshotRepositoryTaskCheckout } from '../repository-task-checkout.js';
const repositoryTasks = vi.hoisted(() => ({ read: vi.fn(), validate: vi.fn() }));
const testHost = vi.hoisted(() => ({ home: '/offline/native-tool-home' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => testHost.home,
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  readRepositoryWorkspaceForConversation: repositoryTasks.read,
  getRepositoryWorkspaces: () => ({ validateHostTask: repositoryTasks.validate }),
}));
vi.mock('../sandboxed-command.js', () => ({
  executeSandboxedCommand: vi.fn().mockResolvedValue({ content: 'done', isError: false }),
}));
vi.mock('../public-github-read.js', () => ({
  executePublicGitHubRead: vi.fn().mockResolvedValue('public repository data'),
}));
vi.mock('../trusted-native-operation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  executeTrustedGitHubRead: vi.fn().mockResolvedValue('{"login":"test"}'),
  executeTrustedGitCommit: vi.fn().mockResolvedValue('[branch abc] approved'),
}));
import { createNativeToolExecutor } from '../native-tool-executor.js';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../ordinary-local-codex-host-runtime.js';

describe('native tool execution through session permissions', () => {
  let root: string;
  let registry: SessionRegistry;
  let abort: AbortController;
  let sent: Record<string, unknown>[];
  beforeEach(async () => {
    repositoryTasks.read.mockReset();
    repositoryTasks.validate.mockReset();
    root = await mkdtemp(join(tmpdir(), 'mitzo-native-'));
    testHost.home = join(root, 'home');
    vi.stubEnv('CODEX_HOME', join(testHost.home, '.codex'));
    await mkdir(testHost.home);
    await mkdir(join(root, 'worktree'));
    registry = new SessionRegistry();
    abort = new AbortController();
    sent = [];
    registry.register('client', {
      transport: { send: (data) => sent.push(data), isOpen: () => true },
      abortController: abort,
      sessionId: 'application-conversation',
      cwd: join(root, 'worktree'),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    registry.get('client')!.worktreePaths.set('repo', {
      path: join(root, 'worktree'),
      wtId: 'wt',
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const call = (name: string, input: Record<string, unknown>) => ({
    type: 'tool_use' as const,
    id: 'call-1',
    name,
    input,
  });
  const executor = () =>
    createNativeToolExecutor('client', registry, { env: { PATH: '/usr/bin:/bin' } });

  it.each([
    ['settled', true],
    ['unknown', true],
    ['unknown', false],
  ] as const)(
    'retains a task command as %s (executor error=%s) through the real task executor adapter',
    async (outcome, isError) => {
      const store = new TaskExecutionStore(join(root, 'events.db'));
      try {
        const session = registry.get('client')!;
        session.cwd = await realpath(session.cwd!);
        const grant = store.approve('operator', session.sessionId!, 'authorization', {
          title: 'Run regression tests',
          network: 'none',
          repositories: [],
          expiresAt: Date.now() + 60000,
          members: [{ sessionId: session.sessionId!, fingerprint: 'scope', roots: [session.cwd] }],
        });
        const before = vi.mocked(executeSandboxedCommand).mock.calls.length;
        const callbacks = new TurnCallbacks();
        vi.mocked(executeSandboxedCommand).mockImplementationOnce(async () => {
          callbacks.seal();
          return retainCallbackOutcome({ content: '1 test failed', isError }, outcome);
        });
        const options = {
          input: {
            operation: 'run' as const,
            grantId: grant.id,
            requestId: 'failed-test',
            command: 'npm test',
          },
          grant,
          sessionId: session.sessionId!,
          session,
          registry,
          clientId: 'client',
          call: { turnId: 'turn', callId: 'failed-call' },
          store,
          signal: abort.signal,
          assertGrant: () => grant,
          assertRuntimeCurrent: async () => {},
        };
        const result = await callbacks.track(() => executeTaskOperation(options));
        expect(result.isError).toBe(true);
        expect(callbackOutcome(result)).toBe(outcome);
        expect(store.runStatus(grant.id, session.sessionId!, 'failed-test').state).toBe(
          outcome === 'settled' ? 'completed' : 'uncertain',
        );
        if (outcome === 'settled') {
          await expect(callbacks.settle(abort.signal)).resolves.toBeUndefined();
          expect(result.content).toBe('1 test failed');
          const retryCallbacks = new TurnCallbacks();
          const retry = retryCallbacks.track(() => executeTaskOperation(options));
          retryCallbacks.seal();
          const replay = await retry;
          expect(replay).toEqual(result);
          expect(callbackOutcome(replay)).toBe('settled');
          await expect(retryCallbacks.settle(abort.signal)).resolves.toBeUndefined();
        } else {
          await expect(callbacks.settle(abort.signal)).rejects.toMatchObject({
            code: 'callbacks_failed',
          });
          expect(JSON.parse(result.content).state).toBe('uncertain');
          await expect(executeTaskOperation(options)).rejects.toThrow(/uncertain/);
        }
        expect(vi.mocked(executeSandboxedCommand).mock.calls.length).toBe(before + 1);
      } finally {
        store.close();
      }
    },
  );

  it('uses an exact trusted task grant for different routine commands without another card', async () => {
    for (const command of ['npm test -- first', 'npm test -- second']) {
      const input = { command };
      const current = vi.fn();
      const execute = createNativeToolExecutor('client', registry, {
        env: { PATH: '/usr/bin:/bin' },
        taskAuthorization: {
          grantId: 'grant',
          toolName: 'Bash',
          input,
          assertCurrentSync: current,
        },
      });
      const result = await execute(call('Bash', input), abort.signal);
      expect(result.is_error).toBe(false);
      expect(current).toHaveBeenCalled();
    }
    expect(sent.filter((event) => event.type === 'permission_request')).toEqual([]);
  });

  it('refuses a task proof for changed input or an unselected operation before effects', async () => {
    const execute = createNativeToolExecutor('client', registry, {
      env: {},
      taskAuthorization: {
        grantId: 'grant',
        toolName: 'Bash',
        input: { command: 'npm test' },
        assertCurrentSync() {},
      },
    });
    const before = vi.mocked(executeSandboxedCommand).mock.calls.length;
    expect((await execute(call('Bash', { command: 'rm -rf .' }), abort.signal)).is_error).toBe(
      true,
    );
    expect((await execute(call('GitHubRead', { endpoint: '/user' }), abort.signal)).is_error).toBe(
      true,
    );
    expect(vi.mocked(executeSandboxedCommand).mock.calls.length).toBe(before);
  });

  it('rechecks task revocation immediately before spawning a command', async () => {
    let revoked = false;
    const input = { command: 'npm test' };
    vi.mocked(executeSandboxedCommand).mockImplementationOnce(async (options) => {
      revoked = true;
      options.beforeSpawn?.();
      return { content: 'must not run', isError: false };
    });
    const execute = createNativeToolExecutor('client', registry, {
      env: {},
      taskAuthorization: {
        grantId: 'grant',
        toolName: 'Bash',
        input,
        assertCurrentSync() {
          if (revoked) throw Error('Task authorization was revoked');
        },
      },
    });
    const output = await execute(call('Bash', input), abort.signal);
    expect(output.is_error).toBe(true);
    expect(output.content).toMatch(/revoked/);
  });

  it.each(['Write', 'GitHubRead'] as const)(
    'rechecks owned runtime revocation after %s approval before host effects',
    async (name) => {
      let revoked = false;
      const execute = createNativeToolExecutor('client', registry, {
        env: { PATH: '/usr/bin:/bin' },
        assertRuntimeCurrent: () => {
          if (revoked) throw new Error('Owned runtime unavailable');
        },
      });
      const beforeReads = vi.mocked(executeTrustedGitHubRead).mock.calls.length;
      const input =
        name === 'Write'
          ? { file_path: 'owned-write', content: 'forbidden', require_approval: true }
          : { endpoint: '/user' };
      const pending = execute(call(name, input), abort.signal);
      await vi.waitFor(() =>
        expect(sent.some((event) => event.type === 'permission_request')).toBe(true),
      );
      revoked = true;
      resolvePending(
        sent.find((event) => event.type === 'permission_request')!.permId as string,
        'once',
      );
      expect(await pending).toMatchObject({ is_error: true, content: 'Owned runtime unavailable' });
      await expect(readFile(join(root, 'worktree/owned-write'))).rejects.toThrow();
      expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(beforeReads);
    },
  );
  it('reconciles asynchronous source authority after approval before file effects', async () => {
    let sourceGranted = true;
    const execute = createNativeToolExecutor('client', registry, {
      env: { PATH: '/usr/bin:/bin' },
      assertRuntimeCurrent: () => {},
      assertRuntimeCurrentAsync: async () => {
        if (!sourceGranted) throw Error('Source grant revoked');
      },
    });
    const pending = execute(
      call('Write', { file_path: 'late-source', content: 'forbidden', require_approval: true }),
      abort.signal,
    );
    await vi.waitFor(() =>
      expect(sent.some((event) => event.type === 'permission_request')).toBe(true),
    );
    sourceGranted = false;
    resolvePending(
      sent.find((event) => event.type === 'permission_request')!.permId as string,
      'once',
    );
    expect(await pending).toMatchObject({ is_error: true, content: 'Source grant revoked' });
    await expect(readFile(join(root, 'worktree/late-source'))).rejects.toThrow();
  });
  it('rechecks owned runtime revocation at the final Bash spawn boundary', async () => {
    registry.setMode('client', 'auto');
    let revoked = false;
    const execute = createNativeToolExecutor('client', registry, {
      env: { PATH: '/usr/bin:/bin' },
      assertRuntimeCurrent: () => {
        if (revoked) throw new Error('Owned runtime unavailable');
      },
    });
    vi.mocked(executeSandboxedCommand).mockImplementationOnce(async (options) => {
      revoked = true;
      options.beforeSpawn!();
      return { content: 'should never execute', isError: false };
    });
    expect(await execute(call('Bash', { command: 'touch forbidden' }), abort.signal)).toMatchObject(
      { is_error: true, content: 'Owned runtime unavailable' },
    );
  });

  it('honors an explicit approval request before a normally allowed write', async () => {
    const pending = executor()(
      call('Write', { file_path: 'approved', content: 'yes', require_approval: true }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    await expect(readFile(join(root, 'worktree/approved'))).rejects.toThrow();
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'deny');
    expect(await pending).toMatchObject({ is_error: true });
    await expect(readFile(join(root, 'worktree/approved'))).rejects.toThrow();
    sent.length = 0;
    const allowed = executor()(
      call('Write', { file_path: 'approved', content: 'yes', require_approval: true }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await allowed).toMatchObject({ is_error: false });
    expect(await readFile(join(root, 'worktree/approved'), 'utf8')).toBe('yes');
  });
  it.each([
    ['GitHubRead', { endpoint: '/user' }],
    ['GitHubRead', { endpoint: '/repos/example/project', access: 'public' }],
    ['Write', { file_path: 'cancelled', content: 'forbidden', require_approval: true }],
    ['Read', { file_path: 'original' }],
    [
      'Edit',
      { file_path: 'original', old_string: 'before', new_string: 'after', require_approval: true },
    ],
    ['Bash', { command: 'touch forbidden' }],
    ['GitCommit', { files: ['original'], message: 'Must not execute' }],
  ] as const)(
    'settles %s cancelled while approval is pending without executing it',
    async (name, input) => {
      await writeFile(join(root, 'worktree/original'), 'before');
      const beforeReads = vi.mocked(executeTrustedGitHubRead).mock.calls.length;
      const beforePublicReads = vi.mocked(executePublicGitHubRead).mock.calls.length;
      const beforeCommits = vi.mocked(executeTrustedGitCommit).mock.calls.length;
      const beforeCommands = vi.mocked(executeSandboxedCommand).mock.calls.length;
      const execute = createNativeToolExecutor('client', registry, { env: {}, forcePrompt: true });
      const pending = execute(
        call(name, { ...input, ...('files' in input ? { files: [...input.files] } : {}) }),
        abort.signal,
      );
      await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
      abort.abort(new Error('Original turn completed'));
      const response = await pending;
      expect(response).toMatchObject({ is_error: true, content: 'Tool execution cancelled' });
      expect(callbackOutcome(response)).toBe('settled');
      expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(beforeReads);
      expect(vi.mocked(executePublicGitHubRead).mock.calls).toHaveLength(beforePublicReads);
      expect(vi.mocked(executeTrustedGitCommit).mock.calls).toHaveLength(beforeCommits);
      expect(vi.mocked(executeSandboxedCommand).mock.calls).toHaveLength(beforeCommands);
      expect(await readFile(join(root, 'worktree/original'), 'utf8')).toBe('before');
      await expect(readFile(join(root, 'worktree/cancelled'))).rejects.toThrow();
    },
  );

  it.each(['authenticated', 'public'] as const)(
    'preserves a positively settled %s GitHub refusal through the native adapter',
    async (access) => {
      const read = access === 'public' ? executePublicGitHubRead : executeTrustedGitHubRead;
      vi.mocked(read).mockRejectedValueOnce(retainCallbackOutcome(Error('HTTP 403'), 'settled'));
      const pending = createNativeToolExecutor('client', registry, { env: {}, forcePrompt: true })(
        call('GitHubRead', { endpoint: '/repos/example/project', access }),
        abort.signal,
      );
      await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
      resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
      const response = await pending;
      expect(response.is_error).toBe(true);
      expect(callbackOutcome(response)).toBe('settled');
    },
  );

  it.each(['authenticated', 'public'] as const)(
    'preserves uncertainty when an already dispatched %s GitHub read is cancelled',
    async (access) => {
      const read = access === 'public' ? executePublicGitHubRead : executeTrustedGitHubRead;
      vi.mocked(read).mockImplementationOnce(async () => {
        abort.abort(new Error('Original turn completed'));
        throw abort.signal.reason;
      });
      const pending = createNativeToolExecutor('client', registry, { env: {}, forcePrompt: true })(
        call('GitHubRead', { endpoint: '/repos/example/project', access }),
        abort.signal,
      );
      await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
      resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
      const response = await pending;
      expect(response.is_error).toBe(true);
      expect(callbackOutcome(response)).toBe('unknown');
    },
  );

  it('retains uncertainty for a write interrupted after entering the file executor', async () => {
    const target = join(root, 'worktree/partial');
    vi.spyOn(nativeFiles, 'executeNativeFileOperation').mockImplementationOnce(async () => {
      await writeFile(target, 'partial effect');
      abort.abort(new Error('Owner stopped after a write'));
      throw abort.signal.reason;
    });
    const response = await executor()(
      call('Write', { file_path: 'partial', content: 'whole' }),
      abort.signal,
    );
    expect(response.is_error).toBe(true);
    expect(callbackOutcome(response)).toBe('unknown');
    expect(await readFile(target, 'utf8')).toBe('partial effect');
  });

  it('retains uncertainty from on-demand workspace creation before tool approval', async () => {
    const onDemandCreate = vi.fn(async () => {
      await writeFile(join(root, 'preparation-started'), 'partial effect');
      abort.abort(new Error('Workspace preparation interrupted'));
      throw abort.signal.reason;
    });
    const execute = createNativeToolExecutor('client', registry, { env: {}, onDemandCreate });
    const response = await execute(
      call('Write', { file_path: join(root, 'outside'), content: 'forbidden' }),
      abort.signal,
    );
    expect(onDemandCreate).toHaveBeenCalledOnce();
    expect(response.is_error).toBe(true);
    expect(callbackOutcome(response)).toBe('unknown');
    await expect(readFile(join(root, 'outside'))).rejects.toThrow();
  });

  it('settles a redirect after the original workspace creator positively completes', async () => {
    const prepared = join(root, 'prepared');
    const onDemandCreate = vi.fn(async () => {
      await mkdir(prepared);
      return { repoName: 'prepared', worktreePath: prepared };
    });
    const execute = createNativeToolExecutor('client', registry, { env: {}, onDemandCreate });
    const response = await execute(
      call('Write', { file_path: join(root, 'outside'), content: 'forbidden' }),
      abort.signal,
    );
    expect(onDemandCreate).toHaveBeenCalledOnce();
    expect(response.is_error).toBe(true);
    expect(callbackOutcome(response)).toBe('settled');
    expect(registry.get('client')!.worktreePaths.get('prepared')?.path).toBe(prepared);
    await expect(readFile(join(root, 'outside'))).rejects.toThrow();
  });

  it('requires initial approval for authenticated GitHub reads without exposing credentials', async () => {
    registry.get('client')!.mode = 'ask';
    const pending = executor()(call('GitHubRead', { endpoint: '/user' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await pending).toMatchObject({ content: '{"login":"test"}', is_error: false });
    expect(executeTrustedGitHubRead).toHaveBeenCalledWith(
      '/user',
      abort.signal,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });
  it('reuses repository consent for different job logs and passes bounded log controls to the transport', async () => {
    const read = (job: number) =>
      executor()(
        call('GitHubRead', {
          endpoint: `/repos/example/project/actions/jobs/${job}/logs`,
          log: { query: 'FAIL', limit: 2000 },
        }),
        abort.signal,
      );
    const first = read(123);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'always');
    expect((await first).is_error).toBe(false);
    sent.length = 0;
    expect((await read(456)).is_error).toBe(false);
    expect(sent.some((e) => e.type === 'permission_request')).toBe(false);
    expect(executeTrustedGitHubRead).toHaveBeenLastCalledWith(
      '/repos/example/project/actions/jobs/456/logs',
      abort.signal,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
      { query: 'FAIL', limit: 2000 },
    );
  });
  it('refuses public log paging and non-log filtering without a prompt or credential fallback', async () => {
    const before = vi.mocked(executeTrustedGitHubRead).mock.calls.length;
    for (const input of [
      { endpoint: '/repos/example/project/actions/jobs/123/logs', access: 'public', log: {} },
      { endpoint: '/repos/example/project/contents/file', log: {} },
    ])
      expect((await executor()(call('GitHubRead', input), abort.signal)).is_error).toBe(true);
    expect(sent.some((e) => e.type === 'permission_request')).toBe(false);
    expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(before);
  });
  it('reads public GitHub data without a card or an authenticated grant', async () => {
    const before = vi.mocked(executeTrustedGitHubRead).mock.calls.length;
    expect(
      await executor()(
        call('GitHubRead', {
          endpoint: '/repos/example/project/pulls',
          access: 'public',
        }),
        abort.signal,
      ),
    ).toMatchObject({ content: 'public repository data', is_error: false });
    expect(sent.some((e) => e.type === 'permission_request')).toBe(false);
    expect(executePublicGitHubRead).toHaveBeenCalled();
    expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(before);
    expect(registry.get('client')!.sessionAllowList.size).toBe(0);

    const authenticated = executor()(
      call('GitHubRead', {
        endpoint: '/repos/example/project/pulls',
        access: 'authenticated',
      }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'deny');
    expect(await authenticated).toMatchObject({ is_error: true });
    expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(before);
  });
  it('never retries a failed public read using host GitHub credentials', async () => {
    const before = vi.mocked(executeTrustedGitHubRead).mock.calls.length;
    vi.mocked(executePublicGitHubRead).mockRejectedValueOnce(
      Error('Public repository unavailable'),
    );
    expect(
      await executor()(
        call('GitHubRead', {
          endpoint: '/repos/example/private',
          access: 'public',
        }),
        abort.signal,
      ),
    ).toMatchObject({ is_error: true, content: 'Public repository unavailable' });
    expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(before);
    expect(sent.some((e) => e.type === 'permission_request')).toBe(false);
  });
  it('keeps explicit project approval requirements for a public read', async () => {
    const before = vi.mocked(executePublicGitHubRead).mock.calls.length;
    const pending = createNativeToolExecutor('client', registry, {
      env: {},
      forcePrompt: true,
    })(call('GitHubRead', { endpoint: '/repos/example/project', access: 'public' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'deny');
    expect(await pending).toMatchObject({ is_error: true });
    expect(vi.mocked(executePublicGitHubRead).mock.calls).toHaveLength(before);
  });
  it('preserves the skill ceiling for public GitHub reads', async () => {
    registry.get('client')!.activeSkillPolicy = new Set(['Read']);
    const before = vi.mocked(executePublicGitHubRead).mock.calls.length;
    expect(
      await executor()(
        call('GitHubRead', {
          endpoint: '/repos/example/project',
          access: 'public',
        }),
        abort.signal,
      ),
    ).toMatchObject({ is_error: true });
    expect(vi.mocked(executePublicGitHubRead).mock.calls).toHaveLength(before);
  });
  it('rejects public account-identity reads without network or credential access', async () => {
    const before = vi.mocked(executePublicGitHubRead).mock.calls.length;
    expect(
      await executor()(call('GitHubRead', { endpoint: '/user', access: 'public' }), abort.signal),
    ).toMatchObject({ is_error: true });
    expect(vi.mocked(executePublicGitHubRead).mock.calls).toHaveLength(before);
  });
  it('reuses repository GitHub read consent for PRs and CI without granting other repositories', async () => {
    registry.get('client')!.mode = 'ask';
    const execute = executor();
    const first = execute(
      call('GitHubRead', { endpoint: '/repos/owner/repo/pulls/1' }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    const card = sent.find((e) => e.type === 'permission_request')!;
    expect(card.title).toBe('Read GitHub repository owner/repo');
    expect(card.sessionGrantDescription).toContain('writes and shell network access');
    resolvePending(card.permId as string, 'always');
    expect(await first).toMatchObject({ is_error: false });

    sent.length = 0;
    const second = await execute(
      call('GitHubRead', { endpoint: '/repos/owner/repo/actions/runs/123/jobs' }),
      abort.signal,
    );
    expect(second).toMatchObject({ is_error: false });
    expect(sent).toEqual([]);
    expect([...registry.get('client')!.sessionAllowList]).toEqual([
      expect.stringMatching(/^github-read-v1:/),
    ]);
    for (const endpoint of ['/repos/owner/other/pulls/1', '/user']) {
      sent.length = 0;
      const next = execute(call('GitHubRead', { endpoint }), abort.signal);
      await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
      resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'deny');
      expect(await next).toMatchObject({ is_error: true });
    }
  });

  it.each(['account', 'runtime', 'revoked'] as const)(
    'does not deliver a GitHub read through a retained %s boundary',
    async (change) => {
      const options = { env: { PATH: '/usr/bin:/bin' }, githubReadRuntimeId: 'runtime' };
      const input = call('GitHubRead', { endpoint: '/repos/owner/repo/actions/runs/123/jobs' });
      const first = createNativeToolExecutor('client', registry, options)(input, abort.signal);
      await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
      resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'always');
      expect(await first).toMatchObject({ is_error: false });
      sent.length = 0;
      const before = vi.mocked(executeTrustedGitHubRead).mock.calls.length;
      if (change === 'account')
        registry.get('client')!.accountBinding = {
          accountId: 'new-account',
          provider: 'openai-codex',
          profileRevision: 'new-revision',
        } as never;
      if (change === 'runtime') options.githubReadRuntimeId = 'new-runtime';
      let checks = 0;
      const next = createNativeToolExecutor('client', registry, {
        ...options,
        assertRuntimeCurrentAsync: async () => {
          if (change === 'revoked' && ++checks === 2)
            registry.get('client')!.sessionAllowList.clear();
        },
      })(input, abort.signal);
      if (change !== 'revoked') {
        await vi.waitFor(() =>
          expect(sent.some((e) => e.type === 'permission_request')).toBe(true),
        );
        resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'deny');
      }
      expect(await next).toMatchObject({ is_error: true });
      if (change === 'revoked') expect(sent).toEqual([]);
      expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(before);
    },
  );
  it('includes an explicit full GitHub view in the original approved request', async () => {
    const before = vi.mocked(executeTrustedGitHubRead).mock.calls.length;
    const pending = executor()(
      call('GitHubRead', { endpoint: '/repos/example/project/pulls', view: 'full' }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    expect(vi.mocked(executeTrustedGitHubRead).mock.calls).toHaveLength(before);
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await pending).toMatchObject({ is_error: false });
    expect(executeTrustedGitHubRead).toHaveBeenLastCalledWith(
      '/repos/example/project/pulls',
      abort.signal,
      undefined,
      undefined,
      'full',
      expect.any(Function),
    );
  });
  it('rejects GitHub traversal before requesting approval', async () => {
    for (const endpoint of [
      '/repos/owner/repo/../../user',
      '/repos/owner/repo/%2e%2e/%2e%2e/user',
      '/repos/owner/repo/%2Fuser',
    ]) {
      const response = await executor()(call('GitHubRead', { endpoint }), abort.signal);
      expect(response).toMatchObject({
        is_error: true,
        content: expect.stringContaining('Invalid native tool input'),
      });
    }
    expect(sent).toEqual([]);
  });
  it('explains unsupported GitHub endpoints without requesting approval or exposing submitted values', async () => {
    const response = await executor()(
      call('GitHubRead', { endpoint: '/search/issues?q=private-query' }),
      abort.signal,
    );
    expect(response.is_error).toBe(true);
    expect(response.content).toContain('/repos/');
    expect(response.content).toContain('not executed');
    expect(response.content).not.toContain('private-query');
    expect(sent).toEqual([]);
  });
  it('explains the narrow commit service limit and routes large commits to native Git', async () => {
    const value = await executor()(
      call('GitCommit', {
        files: Array.from({ length: 218 }, (_, index) => `changed-${index}.txt`),
        message: 'Merge accepted main',
      }),
      abort.signal,
    );
    expect(value).toMatchObject({ is_error: true });
    expect(value.content).toMatch(/64.*native Git/i);
    expect(sent.some((event) => event.type === 'permission_request')).toBe(false);
  });

  it('commits only canonical approved workspace paths through the trusted operation', async () => {
    await writeFile(join(root, 'worktree/change.txt'), 'change');
    const approved = await lstat(join(root, 'worktree/change.txt'));
    const pending = executor()(
      call('GitCommit', { files: ['./change.txt', 'change.txt'], message: 'test: approved' }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await pending).toMatchObject({ is_error: false });
    expect(executeTrustedGitCommit).toHaveBeenCalledWith(
      await realpath(join(root, 'worktree')),
      ['change.txt'],
      'test: approved',
      abort.signal,
      undefined,
      undefined,
      new Map([
        [
          'change.txt',
          {
            dev: approved.dev,
            ino: approved.ino,
            sha256: createHash('sha256').update('change').digest('hex'),
          },
        ],
      ]),
      undefined,
    );
  });
  it('pins the approved file identity across the approval wait', async () => {
    const file = join(root, 'worktree/change.txt');
    await writeFile(file, 'approved');
    const approved = await lstat(file);
    const pending = executor()(
      call('GitCommit', { files: ['change.txt'], message: 'test: approved identity' }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    await rename(file, join(root, 'worktree/original.txt'));
    await writeFile(file, 'replacement');
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    await pending;
    expect(executeTrustedGitCommit).toHaveBeenLastCalledWith(
      await realpath(join(root, 'worktree')),
      ['change.txt'],
      'test: approved identity',
      abort.signal,
      undefined,
      undefined,
      new Map([
        [
          'change.txt',
          {
            dev: approved.dev,
            ino: approved.ino,
            sha256: createHash('sha256').update('approved').digest('hex'),
          },
        ],
      ]),
      undefined,
    );
  });
  it('derives standalone commit authority from the controller claim after approval', async () => {
    await writeFile(join(root, 'worktree/change.txt'), 'change');
    const task = {
      directory: await realpath(join(root, 'worktree')),
      featureBranch: 'mitzo/task',
      root: { dev: 1, ino: 2 },
      git: { dev: 1, ino: 3 },
    };
    repositoryTasks.read.mockReturnValue({ id: 'private-controller-claim' });
    repositoryTasks.validate.mockResolvedValue(task);
    const pending = executor()(
      call('GitCommit', { files: ['change.txt'], message: 'test: task commit' }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await pending).toMatchObject({ is_error: false });
    expect(repositoryTasks.validate).toHaveBeenCalledWith(
      'application-conversation',
      task.directory,
    );
    expect(vi.mocked(executeTrustedGitCommit).mock.calls.at(-1)?.[7]).toEqual(task);

    sent.length = 0;
    vi.mocked(executeTrustedGitCommit).mockClear();
    repositoryTasks.validate.mockRejectedValue(
      new Error('Retained repository task identity changed'),
    );
    const refused = executor()(
      call('GitCommit', { files: ['change.txt'], message: 'test: refuse' }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await refused).toMatchObject({
      is_error: true,
      content: 'Retained repository task identity changed',
    });
    expect(executeTrustedGitCommit).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'runs the real commit on a retained linked task after approval (branch changed: %s)',
    async (changeBranch) => {
      const canonical = await realpath(root);
      const repo = join(canonical, 'source');
      const worktree = join(canonical, 'worktree');
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
      execFileSync('git', ['init', '-q', repo]);
      git(repo, 'config', 'user.name', 'Offline fixture');
      git(repo, 'config', 'user.email', 'offline@example.invalid');
      git(repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial');
      const base = git(repo, 'rev-parse', 'HEAD');
      const { localSource } = await captureLocalRepository('test', repo, abort.signal, 'HEAD');
      const branch = 'mitzo/retained-task';
      git(repo, 'worktree', 'add', '-b', branch, worktree);
      const task = await snapshotRepositoryTaskCheckout(worktree, branch, localSource);
      repositoryTasks.read.mockReturnValue({ id: 'controller-claim' });
      repositoryTasks.validate.mockResolvedValue(task);
      const actual = await vi.importActual<typeof import('../trusted-native-operation.js')>(
        '../trusted-native-operation.js',
      );
      vi.mocked(executeTrustedGitCommit).mockImplementationOnce(actual.executeTrustedGitCommit);
      await writeFile(join(worktree, 'change.txt'), 'approved change');
      await writeFile(join(worktree, 'unselected.txt'), 'keep uncommitted');
      const pending = executor()(
        call('GitCommit', { files: ['change.txt'], message: 'test: retained linked task' }),
        abort.signal,
      );
      await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
      expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
      if (changeBranch) git(worktree, 'switch', '-c', 'mitzo/changed');
      resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
      expect(await pending).toMatchObject({ is_error: changeBranch });
      if (changeBranch) expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
      else {
        expect(git(worktree, 'show', 'HEAD:change.txt')).toBe('approved change');
        expect(git(worktree, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe(
          'change.txt',
        );
      }
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
      expect(git(worktree, 'status', '--porcelain')).toContain('?? unselected.txt');
    },
  );
  it('rejects GitCommit directories before approval or recursive staging', async () => {
    await mkdir(join(root, 'worktree/changes'));
    await writeFile(join(root, 'worktree/changes/.env'), 'SECRET=synthetic');
    const result = await executor()(
      call('GitCommit', { files: ['changes'], message: 'unsafe recursive commit' }),
      abort.signal,
    );
    expect(result).toMatchObject({
      is_error: true,
      content: expect.stringContaining('regular files'),
    });
    expect(sent).toEqual([]);
  });
  it('returns structured answers through the native question tool in ask mode', async () => {
    registry.get('client')!.mode = 'ask';
    const pending = executor()(
      call('AskUserQuestion', {
        questions: [
          { question: 'Which account?', options: [{ label: 'Work', description: 'Work billing' }] },
        ],
      }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    const request = sent.find((e) => e.type === 'permission_request')!;
    expect(request.questions).toEqual([expect.objectContaining({ id: 'Which account?' })]);
    resolvePending(request.permId as string, 'once', { 'Which account?': ['Work'] });
    expect(await pending).toMatchObject({
      is_error: false,
      content: JSON.stringify({ answers: { 'Which account?': 'Work' } }),
    });
  });
  it('blocks native writes to enrolled runtime authority before runtime initialization', async () => {
    const workspace = await realpath(join(root, 'worktree'));
    const enrollment = join(workspace, 'runtime-enrollment.json');
    const config = join(workspace, 'runtime-config.json');
    const python = join(workspace, 'python');
    const gws = join(workspace, 'gws');
    await writeFile(python, 'synthetic interpreter');
    await writeFile(gws, 'synthetic provider executable');
    await writeFile(
      config,
      JSON.stringify({ gwsExecutable: gws, jiraLibPath: join(workspace, 'jira') }),
      { mode: 0o600 },
    );
    await writeFile(
      enrollment,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config,
        release: join(workspace, 'runtime'),
        python,
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', enrollment);
    for (const file_path of [enrollment, config, python, gws]) {
      const original = await readFile(file_path, 'utf8');
      expect(
        await executor()(call('Write', { file_path, content: 'changed authority' }), abort.signal),
      ).toMatchObject({ is_error: true });
      expect(await readFile(file_path, 'utf8')).toBe(original);
    }
    expect(
      await executor()(call('Write', { file_path: 'report.md', content: 'report' }), abort.signal),
    ).toMatchObject({ is_error: false });
  });
  it('protects qualified local Codex selectors and native bytes from task writes, aliases and Bash', async () => {
    const workspace = await realpath(join(root, 'worktree'));
    const nativeFile = join(workspace, 'native-selection.json');
    const targetFile = join(workspace, 'target-selection.json');
    const executable = join(workspace, 'selected-codex');
    const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(executable, bytes, { mode: 0o755 });
    const companion = join(workspace, 'codex-code-mode-host');
    await writeFile(companion, bytes, { mode: 0o755 });
    await writeFile(
      nativeFile,
      JSON.stringify({
        version: 2,
        executablePath: executable,
        executableSha256: sha256,
        codeModeHostSha256: sha256,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      targetFile,
      JSON.stringify({
        version: 1,
        targetId: 'fixture-mac',
        label: 'Fixture Mac',
        hostId: hostname(),
        runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256, sha256),
      }),
      { mode: 0o600 },
    );
    const runtime = new OrdinaryLocalCodexHostRuntime({
      MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativeFile,
      MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetFile,
    });
    await runtime.observe();
    const aliases: string[] = [];
    for (const [index, target] of [nativeFile, targetFile, executable, companion].entries()) {
      const alias = join(workspace, `selection-alias-${index}`);
      await symlink(target, alias);
      aliases.push(alias);
    }
    const snapshots = await Promise.all(
      [nativeFile, targetFile, executable, companion].map((path) => readFile(path)),
    );
    for (const file_path of [nativeFile, targetFile, executable, companion, ...aliases])
      expect(
        await executor()(call('Write', { file_path, content: 'model replacement' }), abort.signal),
      ).toMatchObject({ is_error: true });
    for (const file_path of [nativeFile, targetFile, ...aliases.slice(0, 2)])
      expect(await executor()(call('Read', { file_path }), abort.signal)).toMatchObject({
        is_error: true,
      });
    registry.setMode('client', 'auto');
    vi.mocked(executeSandboxedCommand).mockClear();
    expect(
      await executor()(
        call('Bash', { command: 'mv native-selection.json replacement.json' }),
        abort.signal,
      ),
    ).toMatchObject({
      is_error: true,
      content: expect.stringContaining('overlaps workspace runtime authority'),
    });
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
    expect(
      await Promise.all(
        [nativeFile, targetFile, executable, companion].map((path) => readFile(path)),
      ),
    ).toEqual(snapshots);
    expect(
      await executor()(
        call('Write', { file_path: 'task-note.md', content: 'editable task data' }),
        abort.signal,
      ),
    ).toMatchObject({ is_error: false });
    expect(await readFile(join(workspace, 'task-note.md'), 'utf8')).toBe('editable task data');
  });
  it('rejects shell writable roots containing enrolled authority instead of relying on exact-file deny rules', async () => {
    const workspace = await realpath(join(root, 'worktree'));
    const enrollment = join(workspace, 'runtime-enrollment.json');
    const config = join(workspace, 'runtime-config.json');
    await writeFile(
      config,
      JSON.stringify({ gwsExecutable: '/synthetic/gws', jiraLibPath: '/synthetic/jira' }),
      { mode: 0o600 },
    );
    await writeFile(
      enrollment,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config,
        release: '/synthetic/runtime',
        python: '/synthetic/python',
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', enrollment);
    registry.get('client')!.mode = 'auto';
    vi.mocked(executeSandboxedCommand).mockClear();
    const result = await executor()(
      call('Bash', { command: 'mv runtime-enrollment.json moved.json' }),
      abort.signal,
    );
    expect(result).toMatchObject({
      is_error: true,
      content: expect.stringContaining('overlaps workspace runtime authority'),
    });
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(enrollment, 'utf8')).config).toBe(config);
    vi.unstubAllEnvs();
    const afterRemoval = await executor()(
      call('Bash', { command: 'mv runtime-config.json changed.json' }),
      abort.signal,
    );
    expect(afterRemoval).toMatchObject({
      is_error: true,
      content: expect.stringContaining('overlaps workspace runtime authority'),
    });
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
  });
  it('protects selected executable link paths even when their physical targets are outside the workspace', async () => {
    const workspace = await realpath(join(root, 'worktree'));
    const authority = await realpath(root);
    const config = join(authority, 'runtime-config.json');
    const enrollment = join(authority, 'runtime-enrollment.json');
    const target = join(authority, 'gws-real');
    await writeFile(target, 'synthetic provider');
    const alias = join(workspace, 'gws-link');
    await symlink(target, alias);
    const parentAlias = join(authority, 'workspace-alias');
    await symlink(workspace, parentAlias);
    const selectedAlias = join(parentAlias, 'gws-link');
    await writeFile(
      config,
      JSON.stringify({ gwsExecutable: selectedAlias, jiraLibPath: '/synthetic/jira' }),
      { mode: 0o600 },
    );
    await writeFile(
      enrollment,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config,
        release: '/synthetic/runtime',
        python: '/synthetic/python',
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', enrollment);
    registry.get('client')!.mode = 'auto';
    vi.mocked(executeSandboxedCommand).mockClear();
    expect(await executor()(call('Bash', { command: 'rm gws-link' }), abort.signal)).toMatchObject({
      is_error: true,
      content: expect.stringContaining('overlaps workspace runtime authority'),
    });
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
  });
  it('protects writable intermediate links in an externally selected executable ancestor chain', async () => {
    const workspace = await realpath(join(root, 'worktree'));
    const authority = await realpath(root);
    const providerDirectory = join(authority, 'provider');
    const trustedDirectory = join(authority, 'trusted');
    await mkdir(providerDirectory);
    await mkdir(trustedDirectory);
    await writeFile(join(providerDirectory, 'gws'), 'synthetic provider');
    await symlink(providerDirectory, join(workspace, 'provider-link'));
    await symlink(join(workspace, 'provider-link'), join(trustedDirectory, 'alias'));
    const config = join(authority, 'runtime-config.json');
    const enrollment = join(authority, 'runtime-enrollment.json');
    await writeFile(
      config,
      JSON.stringify({
        gwsExecutable: join(trustedDirectory, 'alias', 'gws'),
        jiraLibPath: '/synthetic/jira',
      }),
      { mode: 0o600 },
    );
    await writeFile(
      enrollment,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config,
        release: '/synthetic/runtime',
        python: '/synthetic/python',
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', enrollment);
    registry.get('client')!.mode = 'auto';
    vi.mocked(executeSandboxedCommand).mockClear();
    expect(
      await executor()(call('Bash', { command: 'rm provider-link' }), abort.signal),
    ).toMatchObject({
      is_error: true,
      content: expect.stringContaining('overlaps workspace runtime authority'),
    });
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
  });
  it('keeps the external common Python interpreter readable and executable for unrelated shell workspaces', async () => {
    const authority = await realpath(root);
    const config = join(authority, 'runtime-config.json');
    const enrollment = join(authority, 'runtime-enrollment.json');
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim();
    await writeFile(
      config,
      JSON.stringify({ gwsExecutable: '/synthetic/gws', jiraLibPath: '/synthetic/jira' }),
      { mode: 0o600 },
    );
    await writeFile(
      enrollment,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config,
        release: '/synthetic/runtime',
        python,
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', enrollment);
    registry.get('client')!.mode = 'auto';
    vi.mocked(executeSandboxedCommand).mockClear();
    expect(
      await executor()(call('Bash', { command: 'python3 -c "print(1)"' }), abort.signal),
    ).toMatchObject({ is_error: false });
    const denied = vi.mocked(executeSandboxedCommand).mock.calls.at(-1)![0].deniedRoots;
    expect(denied).not.toContain(await realpath(python));
    expect(denied).toContain(enrollment);
  });
  it('writes, edits and reads using SDK-compatible inputs and call IDs', async () => {
    const execute = executor();
    expect(
      await execute(call('Write', { file_path: 'note.txt', content: 'first' }), abort.signal),
    ).toMatchObject({ tool_use_id: 'call-1', is_error: false });
    await execute(
      call('Edit', { file_path: 'note.txt', old_string: 'first', new_string: 'second' }),
      abort.signal,
    );
    expect(await execute(call('Read', { file_path: 'note.txt' }), abort.signal)).toMatchObject({
      content: 'second',
      is_error: false,
    });
  });
  it('resolves worktree aliases without mutating registry-owned paths', async () => {
    const alias = join(root, 'alias');
    await symlink(join(root, 'worktree'), alias);
    const entry = { path: alias, wtId: 'wt' };
    registry.get('client')!.worktreePaths.set('repo', entry);
    expect(
      await executor()(call('Write', { file_path: 'note', content: 'ok' }), abort.signal),
    ).toMatchObject({ is_error: false });
    expect(entry.path).toBe(alias);
  });
  it('reports a missing worktree explicitly', async () => {
    await rm(join(root, 'worktree'), { recursive: true });
    expect(await executor()(call('Read', { file_path: 'note' }), abort.signal)).toMatchObject({
      is_error: true,
      content: expect.stringContaining('Session worktree is unavailable'),
    });
  });
  it('enforces the active skill ceiling even for read-only tools', async () => {
    registry.get('client')!.activeSkillPolicy = new Set(['Write']);
    const result = await executor()(call('Read', { file_path: 'missing' }), abort.signal);
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain('skill policy');
  });
  it('denies relative traversal and symlink writes outside worktrees', async () => {
    await writeFile(join(root, 'outside'), 'original');
    await symlink(join(root, 'outside'), join(root, 'worktree/link'));
    for (const file_path of ['../outside', 'link']) {
      expect(
        await executor()(call('Write', { file_path, content: 'changed' }), abort.signal),
      ).toMatchObject({ is_error: true });
    }
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('original');
  });
  it('denies native reads of private credential storage, including through symlinks', async () => {
    const privateRoot = join(root, 'private');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, 'auth.json'), 'synthetic-credential');
    await symlink(privateRoot, join(root, 'worktree/private-link'));
    for (const file_path of [join(privateRoot, 'auth.json'), 'private-link/auth.json']) {
      const result = await executor()(call('Read', { file_path }), abort.signal);
      expect(result.is_error).toBe(true);
      expect(result.content).not.toContain('synthetic-credential');
    }
  });
  it('protects configured login roots after their profile is removed or becomes unreadable', async () => {
    const privateRoot = join(root, 'login');
    const profiles = join(root, 'profiles.json');
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, 'auth.json'), 'synthetic-credential');
    await writeFile(
      profiles,
      JSON.stringify([
        {
          id: 'personal',
          label: 'Personal',
          provider: 'openai-codex',
          credentialRef: privateRoot,
          email: 'test@example.invalid',
          planType: 'test',
          models: [{ id: 'test-model', label: 'Test' }],
        },
      ]),
    );
    vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', profiles);
    // Other server paths load the profile before any native tool observes it.
    loadAccountProfiles();
    for (const next of ['[]', '{invalid']) {
      if (next !== null) await writeFile(profiles, next);
      const result = await executor()(
        call('Read', { file_path: join(privateRoot, 'auth.json') }),
        abort.signal,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).not.toContain('synthetic-credential');
    }
  });
  it('rechecks credential ownership after an approval wait', async () => {
    const privateRoot = join(root, 'worktree/promoted');
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, 'note'), 'original');
    const pending = executor()(
      call('Write', { file_path: 'promoted/note', content: 'changed', require_approval: true }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect((await pending).is_error).toBe(true);
    expect(await readFile(join(privateRoot, 'note'), 'utf8')).toBe('original');
  });
  it('rejects a write target replaced by an outside symlink while approval is pending', async () => {
    const target = join(root, 'worktree/approved');
    const outside = join(root, 'outside');
    await writeFile(target, 'reviewed');
    await writeFile(outside, 'original');
    const pending = executor()(
      call('Write', { file_path: 'approved', content: 'changed', require_approval: true }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    await rm(target);
    await symlink(outside, target);
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    const result = await pending;
    expect(await readFile(outside, 'utf8')).toBe('original');
    expect(result.is_error).toBe(true);
  });
  it('denies a dangling symlink installed while creation approval is pending', async () => {
    const outside = join(root, 'not-created');
    const pending = executor()(
      call('Write', { file_path: 'approved', content: 'escaped', require_approval: true }),
      abort.signal,
    );
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    await symlink(outside, join(root, 'worktree/approved'));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    const result = await pending;
    expect(result.is_error).toBe(true);
    await expect(readFile(outside)).rejects.toThrow();
  });

  it('asks before executing a command in Agent and passes isolated roots', async () => {
    vi.mocked(executeSandboxedCommand).mockClear();
    const pending = executor()(call('Bash', { command: 'npm test' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await pending).toMatchObject({ is_error: false, content: 'done' });
    expect(executeSandboxedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm test',
        cwd: await realpath(join(root, 'worktree')),
        writableRoots: [await realpath(join(root, 'worktree'))],
        deniedRoots: expect.any(Array),
        signal: abort.signal,
      }),
    );
  });
  it('rejects Bash network grants instead of exposing a hostname-only egress boundary', async () => {
    vi.mocked(executeSandboxedCommand).mockClear();
    registry.setMode('client', 'auto');
    expect(
      await executor()(
        call('Bash', {
          command: 'curl https://api.github.com/user',
          allowed_domains: ['api.github.com'],
        }),
        abort.signal,
      ),
    ).toMatchObject({
      is_error: true,
      content: expect.stringContaining('Invalid native tool input'),
    });
    expect(sent).toHaveLength(0);
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
  });
  it('uses the existing Agent approval and session grant for network-enabled host commands', async () => {
    vi.mocked(executeSandboxedCommand).mockClear();
    registry.get('client')!.sessionAllowList.add('Bash');
    const execute = createNativeToolExecutor('client', registry, {
      env: { PATH: '/usr/bin:/bin' },
      networkAccess: 'approved-command',
    });
    const pending = execute(call('Bash', { command: 'npm install' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    const request = sent.find((e) => e.type === 'permission_request')!;
    expect(request.title).toContain('network access');
    expect(request.sessionGrantDescription).toContain('network access');
    const { permissionNotificationCategory } = await import('../notification-actions.js');
    expect(permissionNotificationCategory(request as never, true)).toBe('SESSION_PERMISSION');
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
    resolvePending(request.permId as string, 'always');
    expect(await pending).toMatchObject({ is_error: false });
    expect(executeSandboxedCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ networkAccess: 'approved-command' }),
    );
    sent.length = 0;
    expect(await execute(call('Bash', { command: 'npm test' }), abort.signal)).toMatchObject({
      is_error: false,
    });
    expect(sent).toHaveLength(0);
    registry.setMode('client', 'ask');
    expect(await execute(call('Bash', { command: 'npm install' }), abort.signal)).toMatchObject({
      is_error: true,
    });
    expect(executeSandboxedCommand).toHaveBeenCalledTimes(2);
  });
  it('rechecks a mode downgrade while a network-enabled command is awaiting approval', async () => {
    vi.mocked(executeSandboxedCommand).mockClear();
    const execute = createNativeToolExecutor('client', registry, {
      env: { PATH: '/usr/bin:/bin' },
      networkAccess: 'approved-command',
    });
    const pending = execute(call('Bash', { command: 'npm install' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    registry.setMode('client', 'ask');
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'always');
    expect(await pending).toMatchObject({ is_error: true });
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
  });
  it('does not upgrade networking if caller options change during command approval', async () => {
    vi.mocked(executeSandboxedCommand).mockClear();
    const options: Parameters<typeof createNativeToolExecutor>[2] = {
      env: { PATH: '/usr/bin:/bin' },
    };
    const execute = createNativeToolExecutor('client', registry, options);
    const pending = execute(call('Bash', { command: 'npm test' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    options.networkAccess = 'approved-command';
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'once');
    expect(await pending).toMatchObject({ is_error: false });
    expect(executeSandboxedCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ networkAccess: undefined }),
    );
  });
  it('allows sandboxed commands in Auto but denies them after switching to Ask', async () => {
    vi.mocked(executeSandboxedCommand).mockClear();
    registry.setMode('client', 'auto');
    expect(await executor()(call('Bash', { command: 'npm test' }), abort.signal)).toMatchObject({
      is_error: false,
    });
    expect(sent).toHaveLength(0);
    registry.setMode('client', 'ask');
    expect(await executor()(call('Bash', { command: 'npm test' }), abort.signal)).toMatchObject({
      is_error: true,
    });
    expect(executeSandboxedCommand).toHaveBeenCalledTimes(1);
  });
  it.each(['ask', 'agent'] as const)(
    'blocks a pending %s downgrade at the command execution boundary',
    async (mode) => {
      registry.setMode('client', 'auto');
      vi.mocked(executeSandboxedCommand).mockImplementationOnce(async (options) => {
        registry.get('client')!.pendingPermissionModes = new Map([[Symbol(), mode]]);
        options.beforeSpawn!();
        return { content: 'should never execute', isError: false };
      });
      expect(
        await executor()(call('Bash', { command: 'touch forbidden' }), abort.signal),
      ).toMatchObject({ is_error: true, content: expect.stringContaining('permissions changed') });
    },
  );
  it('refuses revoked repository authority after awaited sandbox preparation', async () => {
    registry.setMode('client', 'auto');
    const grant = join(root, 'repository-grant');
    await writeFile(grant, 'allowed');
    const assertRuntimeCurrentAsync = async () => {
      if ((await readFile(grant, 'utf8')) !== 'allowed') throw Error('Repository grant revoked');
    };
    vi.mocked(executeSandboxedCommand).mockImplementationOnce(async (options) => {
      await writeFile(grant, 'revoked');
      await options.beforeSpawnAsync?.();
      options.beforeSpawn?.();
      await writeFile(join(root, 'worktree/forbidden'), 'executed');
      return { content: 'executed', isError: false };
    });
    const execute = createNativeToolExecutor('client', registry, {
      env: {},
      assertRuntimeCurrentAsync,
      assertRuntimeCurrent: () => {},
    });
    expect(await execute(call('Bash', { command: 'touch forbidden' }), abort.signal)).toMatchObject(
      { is_error: true, content: expect.stringContaining('Repository grant revoked') },
    );
    await expect(readFile(join(root, 'worktree/forbidden'))).rejects.toThrow();
  });
  it('rechecks Ask and skill downgrades at the final sandbox spawn boundary', async () => {
    registry.setMode('client', 'auto');
    vi.mocked(executeSandboxedCommand).mockImplementationOnce(async (options) => {
      registry.setMode('client', 'ask');
      options.beforeSpawn!();
      return { content: 'should never execute', isError: false };
    });
    expect(
      await executor()(call('Bash', { command: 'touch forbidden' }), abort.signal),
    ).toMatchObject({ is_error: true, content: expect.stringContaining('permissions changed') });
    registry.setMode('client', 'auto');
    vi.mocked(executeSandboxedCommand).mockImplementationOnce(async (options) => {
      registry.get('client')!.activeSkillPolicy = new Set(['Read']);
      options.beforeSpawn!();
      return { content: 'should never execute', isError: false };
    });
    expect(
      await executor()(call('Bash', { command: 'touch forbidden' }), abort.signal),
    ).toMatchObject({ is_error: true, content: expect.stringContaining('permissions changed') });
  });
  it('rejects oversized reads and edits without changing the file', async () => {
    await writeFile(join(root, 'worktree/large'), 'a' + 'x'.repeat(32));
    const execute = createNativeToolExecutor('client', registry, { env: {}, maxOutputBytes: 8 });
    for (const tool of [
      call('Read', { file_path: 'large' }),
      call('Edit', { file_path: 'large', old_string: 'a', new_string: 'b' }),
    ]) {
      expect(await execute(tool, abort.signal)).toMatchObject({
        is_error: true,
        content: expect.stringMatching(/limit/),
      });
    }
    expect(await readFile(join(root, 'worktree/large'), 'utf8')).toBe('a' + 'x'.repeat(32));
  });
  it.each([8, 9])(
    'enforces the exact byte boundary for a %i-byte file with an 8-byte limit',
    async (size) => {
      await writeFile(join(root, 'worktree/boundary'), 'x'.repeat(size));
      const execute = createNativeToolExecutor('client', registry, { env: {}, maxOutputBytes: 8 });
      const result = await execute(call('Read', { file_path: 'boundary' }), abort.signal);
      expect(result.is_error).toBe(size > 8);
      if (size === 8) expect(result.content).toBe('xxxxxxxx');
    },
  );
  it('uses existing permission policy for explicitly unisolated sessions', async () => {
    registry.get('client')!.worktreePaths.clear();
    expect(
      await executor()(call('Write', { file_path: 'note', content: 'allowed' }), abort.signal),
    ).toMatchObject({ is_error: false });
    expect(await readFile(join(root, 'worktree/note'), 'utf8')).toBe('allowed');
  });
  it('requires a unique Edit match', async () => {
    await writeFile(join(root, 'worktree/note'), 'same same');
    for (const old_string of ['absent', 'same']) {
      expect(
        await executor()(
          call('Edit', { file_path: 'note', old_string, new_string: 'new' }),
          abort.signal,
        ),
      ).toMatchObject({ is_error: true, content: expect.stringContaining('exactly one') });
    }
  });
  it('rejects malformed, unknown and already cancelled calls', async () => {
    for (const block of [call('Write', { file_path: 'bad' }), call('mcp__missing__tool', {})]) {
      const result = await executor()(block, abort.signal);
      expect(result).toMatchObject({ is_error: true });
      expect(callbackOutcome(result)).toBe('settled');
    }
    abort.abort();
    const cancelled = await executor()(
      call('Write', { file_path: 'bad', content: 'no' }),
      abort.signal,
    );
    expect(cancelled).toMatchObject({ is_error: true });
    expect(callbackOutcome(cancelled)).toBe('settled');
    await expect(readFile(join(root, 'worktree/bad'))).rejects.toThrow();
  });
  it('preserves ask mode read-only behavior without relying on SDK plan mode', async () => {
    registry.get('client')!.mode = 'ask';
    expect(
      await executor()(call('Write', { file_path: 'bad', content: 'no' }), abort.signal),
    ).toMatchObject({ is_error: true });
    expect(sent).toHaveLength(0);
    await expect(readFile(join(root, 'worktree/bad'))).rejects.toThrow();
  });
});
