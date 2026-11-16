import { beforeEach, expect, it, vi } from 'vitest';
const execute = vi.hoisted(() => vi.fn());
const mkdir = vi.hoisted(() => vi.fn());
vi.mock('../sandboxed-command.js', () => ({ executeSandboxedCommand: execute }));
vi.mock('../sdk-repository-directory.js', () => ({ createSdkRepositoryDirectory: mkdir }));
import { sdkSecondaryRepositoryFilesystem } from '../sdk-secondary-repository-filesystem.js';

beforeEach(() => {
  execute.mockReset();
  mkdir.mockReset().mockResolvedValue(undefined);
});
const fixture = () => {
  const assertCurrent = vi.fn().mockResolvedValue(undefined);
  const signal = new AbortController().signal;
  return {
    assertCurrent,
    signal,
    filesystem: sdkSecondaryRepositoryFilesystem({
      workspaceDirectory: '/owned/workspace',
      commonDirectory: '/approved/source/.git',
      taskName: 'claude-fixed',
      conversationId: 'original-conversation',
      signal,
      assertCurrent,
    }),
  };
};
it('refuses a failed OS boundary instead of falling back to controller writes', async () => {
  const f = fixture();
  execute.mockResolvedValue({ content: 'sandbox unavailable', isError: true });
  await expect(f.filesystem.git(['status'], {})).rejects.toMatchObject({
    code: 'SDK_REPOSITORY_FILESYSTEM_FAILED',
  });
  expect(execute).toHaveBeenCalledOnce();
});
it('confines Git and directory creation to the approved roots and checks the original owner at spawn', async () => {
  const f = fixture();
  execute.mockImplementation(async (options) => {
    await options.beforeSpawnAsync();
    return { isError: false, content: 'transport', stdout: 'git output', stderr: '' };
  });
  await f.filesystem.mkdir('/owned/workspace/.claude');
  expect(await f.filesystem.git(['status'], {}, '/private/scratch')).toEqual({
    stdout: 'git output',
    stderr: '',
  });
  expect(mkdir).toHaveBeenCalledWith('/owned/workspace', '/owned/workspace/.claude', f.signal);
  expect(execute.mock.calls.map(([options]) => options.writableRoots)).toEqual([
    ['/owned/workspace/.claude', '/private/scratch'],
  ]);
  expect(execute.mock.calls[0][0].cwd).toBe('/owned/workspace/.claude');
  for (const [options] of execute.mock.calls) {
    expect(options.signal).toBe(f.signal);
    expect(options.networkAccess).toBeUndefined();
    expect(options.beforeSpawnAsync).toBe(f.assertCurrent);
  }
  expect(execute.mock.calls[0][0].additionalWritePaths).toEqual([
    '/approved/source/.git/worktrees/claude-fixed',
    '/approved/source/.git/refs/heads/mitzo/claude-fixed',
    '/approved/source/.git/refs/heads/mitzo/claude-fixed.lock',
    '/approved/source/.git/logs/refs/heads/mitzo/claude-fixed',
    '/approved/source/.git/logs/refs/heads/mitzo/claude-fixed.lock',
  ]);
});
it('does not dispatch another effect after the original owner is revoked', async () => {
  const f = fixture();
  f.assertCurrent.mockRejectedValue(Error('revoked original owner'));
  await expect(f.filesystem.git(['status'], {})).rejects.toThrow('revoked original owner');
  expect(execute).not.toHaveBeenCalled();
});
it('retains a thrown sandbox failure as the cause of an observable allocation failure', async () => {
  const f = fixture();
  const cause = Error('OS sandbox dependencies unavailable');
  execute.mockRejectedValue(cause);
  await expect(f.filesystem.git(['status'], {})).rejects.toMatchObject({
    code: 'SDK_REPOSITORY_FILESYSTEM_FAILED',
    cause,
  });
});
it('retains separate sandbox diagnostics when a completed command fails', async () => {
  const f = fixture();
  execute.mockResolvedValue({
    isError: true,
    content: '',
    stdout: '',
    stderr: 'sandbox initialization refused',
  });
  await expect(f.filesystem.git(['status'], {})).rejects.toMatchObject({
    code: 'SDK_REPOSITORY_FILESYSTEM_FAILED',
    cause: { message: 'sandbox initialization refused' },
  });
});
