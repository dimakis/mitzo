import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';

// Mock child_process before importing the module under test.
// execFile must be a real callback-style function so promisify() works at module load.
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (...args: unknown[]) => void) => {
      if (cb) cb(null, '', '');
    },
  ),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock constants
vi.mock('../constants.js', () => ({
  WORKTREE_BRANCH_PREFIX: 'session/',
  WORKTREE_STALE_HOURS: 96,
  WORKTREE_GIT_TIMEOUT_MS: 30_000,
  WORKTREE_REMOVE_TIMEOUT_MS: 15_000,
  WORKTREE_PRUNE_TIMEOUT_MS: 5_000,
}));

// Mock fs — we only need existsSync for getRepoRemote's indirection
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
  };
});

import { getRepoRemote, rescueDirtyWorktree } from '../worktree.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('getRepoRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses SSH remote URL (git@github.com:user/repo.git)', () => {
    mockExecFileSync.mockReturnValueOnce('git@github.com:dimakis/mgmt.git\n' as never);

    const result = getRepoRemote('/tmp/repo');
    expect(result).toBe('dimakis/mgmt');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/tmp/repo', 'remote', 'get-url', 'origin'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('parses HTTPS remote URL (https://github.com/user/repo.git)', () => {
    mockExecFileSync.mockReturnValueOnce('https://github.com/dimakis/mitzo.git\n' as never);

    const result = getRepoRemote('/tmp/repo');
    expect(result).toBe('dimakis/mitzo');
  });

  it('parses HTTPS remote URL without .git suffix', () => {
    mockExecFileSync.mockReturnValueOnce('https://github.com/dimakis/mitzo\n' as never);

    const result = getRepoRemote('/tmp/repo');
    expect(result).toBe('dimakis/mitzo');
  });

  it('parses SSH remote URL without .git suffix', () => {
    mockExecFileSync.mockReturnValueOnce('git@github.com:dimakis/mitzo\n' as never);

    const result = getRepoRemote('/tmp/repo');
    expect(result).toBe('dimakis/mitzo');
  });

  it('returns null when git command fails', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('fatal: No such remote');
    });

    const result = getRepoRemote('/tmp/repo');
    expect(result).toBeNull();
  });

  it('returns null for unrecognised URL format', () => {
    mockExecFileSync.mockReturnValueOnce('/local/path/to/repo\n' as never);

    const result = getRepoRemote('/tmp/repo');
    expect(result).toBeNull();
  });
});

describe('rescueDirtyWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds when all four steps work (add, commit, push, gh pr create)', () => {
    // Step 0: getRepoRemote — git remote get-url origin
    mockExecFileSync.mockReturnValueOnce('git@github.com:dimakis/mgmt.git\n' as never);
    // Step 1: git add -u
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 2: git commit
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 3: git push
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 4: gh pr create
    mockExecFileSync.mockReturnValueOnce('https://github.com/dimakis/mgmt/pull/42\n' as never);

    const result = rescueDirtyWorktree('/tmp/worktree', 'session/test-123', 'test-123');

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe('https://github.com/dimakis/mgmt/pull/42');

    // Verify git add -u was called (not -A, to avoid staging untracked secrets)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/tmp/worktree', 'add', '-u'],
      expect.objectContaining({ timeout: 30_000 }),
    );

    // Verify git commit was called
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      [
        '-C',
        '/tmp/worktree',
        'commit',
        '-m',
        'chore: rescue uncommitted work from session test-123',
      ],
      expect.objectContaining({ timeout: 30_000 }),
    );

    // Verify git push was called
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/tmp/worktree', 'push', 'origin', 'session/test-123'],
      expect.objectContaining({ timeout: 30_000 }),
    );

    // Verify gh pr create was called
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--title',
        'Rescued: test-123',
        '--body',
        expect.stringContaining('Auto-rescued uncommitted work'),
        '--repo',
        'dimakis/mgmt',
        '--head',
        'session/test-123',
      ],
      expect.objectContaining({ cwd: '/tmp/worktree', timeout: 30_000 }),
    );
  });

  it('returns failure when git add fails', () => {
    // Step 0: getRepoRemote
    mockExecFileSync.mockReturnValueOnce('git@github.com:dimakis/mgmt.git\n' as never);
    // Step 1: git add -u fails (staging tracked files)
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('git add failed');
    });

    const result = rescueDirtyWorktree('/tmp/worktree', 'session/test-123', 'test-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('git add failed');
    expect(result.prUrl).toBeUndefined();
  });

  it('returns failure when git commit fails', () => {
    // Step 0: getRepoRemote
    mockExecFileSync.mockReturnValueOnce('git@github.com:dimakis/mgmt.git\n' as never);
    // Step 1: git add -u succeeds
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 2: git commit fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('nothing to commit');
    });

    const result = rescueDirtyWorktree('/tmp/worktree', 'session/test-123', 'test-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('nothing to commit');
  });

  it('returns failure when git push fails', () => {
    // Step 0: getRepoRemote
    mockExecFileSync.mockReturnValueOnce('git@github.com:dimakis/mgmt.git\n' as never);
    // Step 1: git add -u
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 2: git commit
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 3: git push fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('remote rejected');
    });

    const result = rescueDirtyWorktree('/tmp/worktree', 'session/test-123', 'test-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('remote rejected');
  });

  it('returns failure when gh pr create fails', () => {
    // Step 0: getRepoRemote
    mockExecFileSync.mockReturnValueOnce('git@github.com:dimakis/mgmt.git\n' as never);
    // Step 1: git add
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 2: git commit
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 3: git push
    mockExecFileSync.mockReturnValueOnce('' as never);
    // Step 4: gh pr create fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('gh: not logged in');
    });

    const result = rescueDirtyWorktree('/tmp/worktree', 'session/test-123', 'test-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('gh: not logged in');
  });

  it('returns failure when remote cannot be resolved', () => {
    // Step 0: getRepoRemote fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('fatal: No such remote');
    });

    const result = rescueDirtyWorktree('/tmp/worktree', 'session/test-123', 'test-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('resolve GitHub remote');
  });
});
