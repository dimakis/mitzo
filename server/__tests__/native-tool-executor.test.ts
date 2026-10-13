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
import { executeTrustedGitCommit, executeTrustedGitHubRead } from '../trusted-native-operation.js';
const repositoryTasks = vi.hoisted(() => ({ read: vi.fn(), validate: vi.fn() }));
vi.mock('../repository-workspace-runtime.js', () => ({
  readRepositoryWorkspaceForConversation: repositoryTasks.read,
  getRepositoryWorkspaces: () => ({ validateHostTask: repositoryTasks.validate }),
}));
vi.mock('../sandboxed-command.js', () => ({
  executeSandboxedCommand: vi.fn().mockResolvedValue({ content: 'done', isError: false }),
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
    );
  });
  it('retains an authenticated GitHub read approval for the session', async () => {
    registry.get('client')!.mode = 'ask';
    const execute = executor();
    const first = execute(call('GitHubRead', { endpoint: '/user' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'always');
    expect(await first).toMatchObject({ is_error: false });

    sent.length = 0;
    const second = await execute(
      call('GitHubRead', { endpoint: '/repos/owner/repo/pulls/1' }),
      abort.signal,
    );
    expect(second).toMatchObject({ is_error: false });
    expect(sent).toEqual([]);
    expect(registry.get('client')!.sessionAllowList).toContain('GitHubRead');
  });
  it('rejects GitHub traversal before requesting approval', async () => {
    for (const endpoint of [
      '/repos/owner/repo/../../user',
      '/repos/owner/repo/%2e%2e/%2e%2e/user',
      '/repos/owner/repo/%2Fuser',
    ]) {
      const response = await executor()(call('GitHubRead', { endpoint }), abort.signal);
      expect(response).toMatchObject({ is_error: true, content: 'Invalid native tool input' });
    }
    expect(sent).toEqual([]);
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
    await writeFile(
      nativeFile,
      JSON.stringify({ version: 1, executablePath: executable, executableSha256: sha256 }),
      { mode: 0o600 },
    );
    await writeFile(
      targetFile,
      JSON.stringify({
        version: 1,
        targetId: 'fixture-mac',
        label: 'Fixture Mac',
        hostId: hostname(),
        runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256),
      }),
      { mode: 0o600 },
    );
    const runtime = new OrdinaryLocalCodexHostRuntime({
      MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativeFile,
      MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetFile,
    });
    await runtime.observe();
    const aliases: string[] = [];
    for (const [index, target] of [nativeFile, targetFile, executable].entries()) {
      const alias = join(workspace, `selection-alias-${index}`);
      await symlink(target, alias);
      aliases.push(alias);
    }
    const snapshots = await Promise.all(
      [nativeFile, targetFile, executable].map((path) => readFile(path)),
    );
    for (const file_path of [nativeFile, targetFile, executable, ...aliases])
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
      await Promise.all([nativeFile, targetFile, executable].map((path) => readFile(path))),
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
    ).toMatchObject({ is_error: true, content: 'Invalid native tool input' });
    expect(sent).toHaveLength(0);
    expect(executeSandboxedCommand).not.toHaveBeenCalled();
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
    expect(await executor()(call('Write', { file_path: 'bad' }), abort.signal)).toMatchObject({
      is_error: true,
    });
    expect(await executor()(call('mcp__missing__tool', {}), abort.signal)).toMatchObject({
      is_error: true,
    });
    abort.abort();
    expect(
      await executor()(call('Write', { file_path: 'bad', content: 'no' }), abort.signal),
    ).toMatchObject({ is_error: true });
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
