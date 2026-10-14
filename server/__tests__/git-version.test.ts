import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn(), execFile: vi.fn() }));

import { execFile, execFileSync } from 'child_process';
import { getLocalCommit, getRemoteCommit, isUpdateAvailable } from '../git-version.js';

const mockExec = vi.mocked(execFile);
const mockSync = vi.mocked(execFileSync);
function result(stdout: string) {
  mockExec.mockImplementationOnce((...args: unknown[]) => {
    (args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void)(null, stdout, '');
    return {} as ReturnType<typeof execFile>;
  });
}
function failure() {
  mockExec.mockImplementationOnce((...args: unknown[]) => {
    (args.at(-1) as (err: Error) => void)(new Error('git failed'));
    return {} as ReturnType<typeof execFile>;
  });
}
beforeEach(() => vi.resetAllMocks());

describe('getLocalCommit', () => {
  it('reads the startup commit', () => {
    mockSync.mockReturnValueOnce(Buffer.from('abc1234\n'));
    expect(getLocalCommit()).toBe('abc1234');
  });
  it('returns null on error', () => {
    mockSync.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    expect(getLocalCommit()).toBeNull();
  });
});

describe('getRemoteCommit', () => {
  it('fetches and reads the remote commit without synchronous subprocesses', async () => {
    result('');
    result('def5678\n');
    expect(await getRemoteCommit()).toBe('def5678');
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      'git',
      ['fetch', 'origin', 'main', '--quiet'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });
  it('returns null if fetch fails', async () => {
    failure();
    expect(await getRemoteCommit()).toBeNull();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

describe('isUpdateAvailable', () => {
  it('compares commits asynchronously', async () => {
    result('abc1234\n');
    result('');
    result('def5678\n');
    expect(await isUpdateAvailable()).toBe(true);
    expect(mockSync).not.toHaveBeenCalled();
  });
  it('returns false for matching commits', async () => {
    result('abc1234\n');
    result('');
    result('abc1234\n');
    expect(await isUpdateAvailable()).toBe(false);
  });
  it('returns false when local lookup fails', async () => {
    failure();
    expect(await isUpdateAvailable()).toBe(false);
  });
  it('shares a pending check while allowing unrelated event-loop work', async () => {
    let finish!: (err: Error | null, stdout: string, stderr: string) => void;
    mockExec.mockImplementationOnce((...args: unknown[]) => {
      finish = args.at(-1) as typeof finish;
      return {} as ReturnType<typeof execFile>;
    });
    const first = isUpdateAvailable();
    const second = isUpdateAvailable();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenCalledTimes(1);
    result('');
    result('def5678\n');
    finish(null, 'abc1234\n', '');
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(mockExec).toHaveBeenCalledTimes(3);
    result('abc1234\n');
    result('');
    result('abc1234\n');
    expect(await isUpdateAvailable()).toBe(false);
  });
});
