import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry, resolvePending, applyTierOverrides } from '@mitzo/harness';
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
    applyTierOverrides({});
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
  it('waits for shell permission and does not execute on denial', async () => {
    // Existing agent mode auto-allows Bash; a configured unknown tier requires approval.
    applyTierOverrides({ Bash: 'unknown' });
    const pending = executor()(call('Bash', { command: 'touch denied' }), abort.signal);
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'permission_request')).toBe(true));
    resolvePending(sent.find((e) => e.type === 'permission_request')!.permId as string, 'deny');
    expect(await pending).toMatchObject({ is_error: true });
    await expect(readFile(join(root, 'worktree/denied'))).rejects.toThrow();
  });
  it('cancels a pending permission without executing the tool', async () => {
    applyTierOverrides({ Bash: 'unknown' });
    const pending = executor()(call('Bash', { command: 'touch cancelled' }), abort.signal);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    abort.abort();
    expect(await pending).toMatchObject({ is_error: true });
    await expect(readFile(join(root, 'worktree/cancelled'))).rejects.toThrow();
  });
  it('executes shell in the session cwd with only the explicit environment', async () => {
    registry.get('client')!.mode = 'auto';
    vi.stubEnv('MITZO_PRIVATE_TEST_SECRET', 'must-not-inherit');
    try {
      const result = await executor()(
        call('Bash', { command: 'printf "%s" "${MITZO_PRIVATE_TEST_SECRET-unset}"; pwd' }),
        abort.signal,
      );
      expect(result.is_error).toBe(false);
      expect(result.content).toContain('unset');
      expect(result.content).toContain('worktree');
      expect(result.content).not.toContain('must-not-inherit');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('labels stderr separately from command output', async () => {
    registry.get('client')!.mode = 'auto';
    const result = await executor()(
      call('Bash', { command: 'printf output; printf diagnostic >&2' }),
      abort.signal,
    );
    expect(result).toMatchObject({
      is_error: false,
      content: 'output\n--- stderr ---\ndiagnostic',
    });
  });
  it('terminates a running shell on cancellation', async () => {
    registry.get('client')!.mode = 'auto';
    const pending = executor()(
      call('Bash', { command: 'touch started; sleep 30; touch too-late' }),
      abort.signal,
    );
    await vi.waitFor(async () =>
      expect(await readFile(join(root, 'worktree/started'), 'utf8')).toBe(''),
    );
    abort.abort();
    expect(await pending).toMatchObject({ is_error: true });
    await expect(readFile(join(root, 'worktree/too-late'))).rejects.toThrow();
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
