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
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { loadAccountProfiles } from '../account-profiles.js';
import { executeSandboxedCommand } from '../sandboxed-command.js';
import { executeTrustedGitCommit, executeTrustedGitHubRead } from '../trusted-native-operation.js';
vi.mock('../sandboxed-command.js', () => ({
  executeSandboxedCommand: vi.fn().mockResolvedValue({ content: 'done', isError: false }),
}));
vi.mock('../trusted-native-operation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  executeTrustedGitHubRead: vi.fn().mockResolvedValue('{"login":"test"}'),
  executeTrustedGitCommit: vi.fn().mockResolvedValue('[branch abc] approved'),
}));
import { createNativeToolExecutor } from '../native-tool-executor.js';

describe('native tool execution through session permissions', () => {
  let root: string;
  let registry: SessionRegistry;
  let abort: AbortController;
  let sent: Record<string, unknown>[];
  beforeEach(async () => {
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
  it('requires an exact approval for authenticated GitHub reads without exposing credentials', async () => {
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
    );
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
