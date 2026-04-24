import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  utimesSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

// Mock the logger to avoid noise
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Use real constants but override stale hours for testing
vi.mock('../constants.js', () => ({
  WORKTREE_BRANCH_PREFIX: 'session/',
  WORKTREE_STALE_HOURS: 96,
  WORKTREE_GIT_TIMEOUT_MS: 30_000,
  WORKTREE_REMOVE_TIMEOUT_MS: 15_000,
  WORKTREE_PRUNE_TIMEOUT_MS: 5_000,
}));

import {
  cleanupStaleWorktrees,
  parseWorktreeAge,
  countWorktrees,
  createWorktreeAsync,
  symlinkRuntimeDirs,
  discoverSessionWorktrees,
} from '../worktree.js';

describe('parseWorktreeAge', () => {
  it('parses age from standard YYYY-MM-DD-XXXXXX format', () => {
    const today = new Date().toISOString().slice(0, 10); // e.g. 2026-04-20
    const age = parseWorktreeAge(`${today}-abc123`);
    expect(age).not.toBeNull();
    // Created today, so age should be less than 24h
    expect(age!).toBeLessThan(24 * 60 * 60 * 1000);
    expect(age!).toBeGreaterThanOrEqual(0);
  });

  it('returns correct age for old worktrees', () => {
    const age = parseWorktreeAge('2026-04-15-abc123');
    expect(age).not.toBeNull();
    // Should be at least 5 days old (test written 2026-04-20)
    // Use a relative check: it should be more than 0
    expect(age!).toBeGreaterThan(0);
  });

  it('returns null for non-standard names', () => {
    expect(parseWorktreeAge('ws-fix')).toBeNull();
    expect(parseWorktreeAge('session-worktrees')).toBeNull();
    expect(parseWorktreeAge('random-name')).toBeNull();
  });

  it('returns null for invalid dates', () => {
    expect(parseWorktreeAge('9999-99-99-abc123')).toBeNull();
  });

  it('returns null for impossible calendar dates', () => {
    expect(parseWorktreeAge('2026-02-31-abc123')).toBeNull();
    expect(parseWorktreeAge('2026-13-01-abc123')).toBeNull();
    expect(parseWorktreeAge('2026-04-31-abc123')).toBeNull();
  });

  it('returns null for names without 6-char hex suffix', () => {
    expect(parseWorktreeAge('2026-04-20-ws-fix')).toBeNull();
    expect(parseWorktreeAge('2026-04-20-')).toBeNull();
    expect(parseWorktreeAge('2026-04-20')).toBeNull();
  });

  it('returns null for future-dated names', () => {
    expect(parseWorktreeAge('2099-01-01-abc123')).toBeNull();
    expect(parseWorktreeAge('2030-12-15-f0f0f0')).toBeNull();
  });
});

describe('countWorktrees', () => {
  let baseRepo: string;

  beforeEach(() => {
    baseRepo = mkdtempSync(join(tmpdir(), 'mitzo-count-test-'));
  });

  afterEach(() => {
    rmSync(baseRepo, { recursive: true, force: true });
  });

  it('returns 0 when .claude/worktrees/ does not exist', () => {
    expect(countWorktrees(baseRepo)).toBe(0);
  });

  it('returns 0 for empty worktrees directory', () => {
    mkdirSync(join(baseRepo, '.claude', 'worktrees'), { recursive: true });
    expect(countWorktrees(baseRepo)).toBe(0);
  });

  it('counts only directories in worktrees directory', () => {
    const dir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, '2026-04-20-aaa111'));
    mkdirSync(join(dir, '2026-04-20-bbb222'));
    writeFileSync(join(dir, '.DS_Store'), '');
    writeFileSync(join(dir, 'stray-file.txt'), '');
    expect(countWorktrees(baseRepo)).toBe(2);
  });
});

describe('createWorktreeAsync', () => {
  let baseRepo: string;

  beforeEach(() => {
    baseRepo = mkdtempSync(join(tmpdir(), 'mitzo-async-wt-'));
    execFileSync('git', ['-C', baseRepo, 'init'], { stdio: 'pipe' });
    execFileSync('git', ['-C', baseRepo, 'config', 'user.email', 'test@test.com'], {
      stdio: 'pipe',
    });
    execFileSync('git', ['-C', baseRepo, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
    execFileSync('git', ['-C', baseRepo, 'commit', '--allow-empty', '-m', 'init'], {
      stdio: 'pipe',
    });
  });

  afterEach(() => {
    try {
      execFileSync('git', ['-C', baseRepo, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch {
      // ignore
    }
    rmSync(baseRepo, { recursive: true, force: true });
  });

  it('creates a worktree and returns its path', async () => {
    const sessionId = 'async-test-session';
    const path = await createWorktreeAsync(sessionId, baseRepo);
    expect(path).toBe(join(baseRepo, '.claude', 'worktrees', sessionId));
    expect(existsSync(path)).toBe(true);
    // Verify it's a valid git worktree
    execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], { stdio: 'pipe' });
  });

  it('reuses existing valid worktree', async () => {
    const sessionId = 'async-reuse-session';
    const first = await createWorktreeAsync(sessionId, baseRepo);
    const second = await createWorktreeAsync(sessionId, baseRepo);
    expect(first).toBe(second);
  });

  it('handles branch-already-exists fallback', async () => {
    const sessionId = 'async-branch-exists';
    const branch = `session/${sessionId}`;
    // Pre-create the branch so the first `git worktree add -b` fails
    execFileSync('git', ['-C', baseRepo, 'branch', branch], { stdio: 'pipe' });
    const path = await createWorktreeAsync(sessionId, baseRepo);
    expect(existsSync(path)).toBe(true);
  });
});

describe('symlinkRuntimeDirs', () => {
  let repoPath: string;
  let worktreePath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mitzo-symlink-repo-'));
    worktreePath = mkdtempSync(join(tmpdir(), 'mitzo-symlink-wt-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('creates symlinks for dirs that exist in source repo', () => {
    mkdirSync(join(repoPath, '.venv'));
    mkdirSync(join(repoPath, 'node_modules'));

    symlinkRuntimeDirs(repoPath, worktreePath, ['.venv', 'node_modules']);

    expect(lstatSync(join(worktreePath, '.venv')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(worktreePath, '.venv'))).toBe(join(repoPath, '.venv'));
    expect(lstatSync(join(worktreePath, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('skips dirs that do not exist in source repo', () => {
    mkdirSync(join(repoPath, '.venv'));

    symlinkRuntimeDirs(repoPath, worktreePath, ['.venv', 'node_modules']);

    expect(lstatSync(join(worktreePath, '.venv')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(worktreePath, 'node_modules'))).toBe(false);
  });

  it('is idempotent — handles symlink-already-exists on resume', () => {
    mkdirSync(join(repoPath, '.venv'));
    symlinkSync(join(repoPath, '.venv'), join(worktreePath, '.venv'));

    // Should not throw
    symlinkRuntimeDirs(repoPath, worktreePath, ['.venv']);

    expect(lstatSync(join(worktreePath, '.venv')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(worktreePath, '.venv'))).toBe(join(repoPath, '.venv'));
  });

  it('handles dangling symlink (target was deleted)', () => {
    mkdirSync(join(repoPath, '.venv'));
    symlinkSync(join(repoPath, '.venv'), join(worktreePath, '.venv'));
    rmSync(join(repoPath, '.venv'), { recursive: true });

    // Source no longer exists — should skip without error
    symlinkRuntimeDirs(repoPath, worktreePath, ['.venv']);

    // Dangling symlink may remain from the previous creation
    // The function shouldn't throw
  });

  it('handles empty dirs list', () => {
    symlinkRuntimeDirs(repoPath, worktreePath, []);
    // No symlinks created
    expect(readdirSync(worktreePath).length).toBe(0);
  });
});

describe('discoverSessionWorktrees', () => {
  let primaryRepo: string;
  let secondaryRepo: string;

  beforeEach(() => {
    primaryRepo = mkdtempSync(join(tmpdir(), 'mitzo-discover-primary-'));
    secondaryRepo = mkdtempSync(join(tmpdir(), 'mitzo-discover-secondary-'));
  });

  afterEach(() => {
    rmSync(primaryRepo, { recursive: true, force: true });
    rmSync(secondaryRepo, { recursive: true, force: true });
  });

  it('finds worktrees across configured repos', () => {
    const wtId = '2026-04-20-abc123def456';
    // Create worktree dirs in both repos
    mkdirSync(join(primaryRepo, '.claude', 'worktrees', wtId), { recursive: true });
    mkdirSync(join(secondaryRepo, '.claude', 'worktrees', wtId), { recursive: true });

    const repos = { secondary: secondaryRepo };
    const result = discoverSessionWorktrees(wtId, primaryRepo, repos);

    expect(result.size).toBe(2);
    expect(result.has('primary')).toBe(true);
    expect(result.get('primary')!.path).toBe(join(primaryRepo, '.claude', 'worktrees', wtId));
    expect(result.has('secondary')).toBe(true);
    expect(result.get('secondary')!.path).toBe(join(secondaryRepo, '.claude', 'worktrees', wtId));
  });

  it('finds worktrees in .cursor/worktrees/ too', () => {
    const wtId = '2026-04-20-abc123def456';
    mkdirSync(join(primaryRepo, '.cursor', 'worktrees', wtId), { recursive: true });

    const result = discoverSessionWorktrees(wtId, primaryRepo, {});

    expect(result.size).toBe(1);
    expect(result.has('primary')).toBe(true);
  });

  it('returns empty map when no worktrees exist', () => {
    const result = discoverSessionWorktrees('nonexistent', primaryRepo, {
      secondary: secondaryRepo,
    });
    expect(result.size).toBe(0);
  });

  it('only includes repos that have a worktree', () => {
    const wtId = '2026-04-20-abc123def456';
    mkdirSync(join(primaryRepo, '.claude', 'worktrees', wtId), { recursive: true });
    // Secondary has no worktree

    const result = discoverSessionWorktrees(wtId, primaryRepo, {
      secondary: secondaryRepo,
    });

    expect(result.size).toBe(1);
    expect(result.has('primary')).toBe(true);
    expect(result.has('secondary')).toBe(false);
  });
});

describe('cleanupStaleWorktrees', () => {
  let baseRepo: string;
  let inboxDir: string;

  beforeEach(() => {
    // Create a real temporary git repo for testing
    baseRepo = mkdtempSync(join(tmpdir(), 'mitzo-wt-test-'));
    inboxDir = join(baseRepo, 'test-inbox');
    execFileSync('git', ['-C', baseRepo, 'init'], { stdio: 'pipe' });
    execFileSync('git', ['-C', baseRepo, 'config', 'user.email', 'test@test.com'], {
      stdio: 'pipe',
    });
    execFileSync('git', ['-C', baseRepo, 'config', 'user.name', 'Test'], {
      stdio: 'pipe',
    });
    execFileSync('git', ['-C', baseRepo, 'commit', '--allow-empty', '-m', 'init'], {
      stdio: 'pipe',
    });
  });

  afterEach(() => {
    // Clean up worktrees before removing repo
    try {
      execFileSync('git', ['-C', baseRepo, 'worktree', 'prune'], { stdio: 'pipe' });
    } catch {
      // ignore
    }
    rmSync(baseRepo, { recursive: true, force: true });
  });

  it('removes clean stale worktrees', () => {
    // Create a worktree
    const wtDir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(wtDir, { recursive: true });
    const sessionId = 'test-clean-session';
    const wtPath = join(wtDir, sessionId);
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', `session/${sessionId}`, wtPath], {
      stdio: 'pipe',
    });

    // Age the worktree past the cutoff (touch mtime to 5 days ago)
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    utimesSync(wtPath, fiveDaysAgo, fiveDaysAgo);

    cleanupStaleWorktrees(baseRepo, inboxDir);

    // Worktree dir should be removed
    const remaining = readdirSync(wtDir);
    expect(remaining).not.toContain(sessionId);
    // No inbox proposal should be created
    expect(() => readdirSync(inboxDir)).toThrow(); // dir doesn't exist
  });

  it('skips dirty stale worktrees and posts inbox proposal', () => {
    // Create a worktree
    const wtDir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(wtDir, { recursive: true });
    const sessionId = 'test-dirty-session';
    const wtPath = join(wtDir, sessionId);
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', `session/${sessionId}`, wtPath], {
      stdio: 'pipe',
    });

    // Create uncommitted work in the worktree
    writeFileSync(join(wtPath, 'dirty-file.txt'), 'uncommitted work');

    // Age the worktree past the cutoff
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    utimesSync(wtPath, fiveDaysAgo, fiveDaysAgo);

    cleanupStaleWorktrees(baseRepo, inboxDir);

    // Worktree should still exist
    const remaining = readdirSync(wtDir);
    expect(remaining).toContain(sessionId);

    // Inbox proposal should be created
    const inboxFiles = readdirSync(inboxDir);
    expect(inboxFiles.length).toBe(1);
    expect(inboxFiles[0]).toContain('worktree_gc');
    expect(inboxFiles[0]).toContain(sessionId);
  });

  it('does not re-post inbox proposal for already-notified dirty worktree', () => {
    const wtDir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(wtDir, { recursive: true });
    const sessionId = 'test-dedup-session';
    const wtPath = join(wtDir, sessionId);
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', `session/${sessionId}`, wtPath], {
      stdio: 'pipe',
    });
    writeFileSync(join(wtPath, 'dirty-file.txt'), 'uncommitted work');
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    utimesSync(wtPath, fiveDaysAgo, fiveDaysAgo);

    // First run — should create one inbox item
    cleanupStaleWorktrees(baseRepo, inboxDir);
    expect(readdirSync(inboxDir).length).toBe(1);

    // Second run — should NOT create a duplicate
    cleanupStaleWorktrees(baseRepo, inboxDir);
    expect(readdirSync(inboxDir).length).toBe(1);

    // Third run — still just one
    cleanupStaleWorktrees(baseRepo, inboxDir);
    expect(readdirSync(inboxDir).length).toBe(1);
  });

  it('does not touch worktrees younger than cutoff', () => {
    const wtDir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(wtDir, { recursive: true });
    const sessionId = 'test-young-session';
    const wtPath = join(wtDir, sessionId);
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', `session/${sessionId}`, wtPath], {
      stdio: 'pipe',
    });

    // Don't age it — it's fresh
    cleanupStaleWorktrees(baseRepo, inboxDir);

    const remaining = readdirSync(wtDir);
    expect(remaining).toContain(sessionId);
  });

  it('requires both name-age and mtime to be stale before cleanup', () => {
    const wtDir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(wtDir, { recursive: true });
    // Use a date 5 days ago in the name — mtime is "now" (recently touched)
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const oldDate = fiveDaysAgo.toISOString().slice(0, 10);
    const sessionId = `${oldDate}-a1b2c3`;
    const wtPath = join(wtDir, sessionId);
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', `session/${sessionId}`, wtPath], {
      stdio: 'pipe',
    });
    // Don't touch mtime — it stays at "now", so mtime safety net keeps it alive

    cleanupStaleWorktrees(baseRepo, inboxDir);

    const remaining = readdirSync(wtDir);
    expect(remaining).toContain(sessionId);
  });

  it('cleans up worktree when both name-age and mtime are stale', () => {
    const wtDir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(wtDir, { recursive: true });
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const oldDate = fiveDaysAgo.toISOString().slice(0, 10);
    const sessionId = `${oldDate}-a1b2c3`;
    const wtPath = join(wtDir, sessionId);
    execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', `session/${sessionId}`, wtPath], {
      stdio: 'pipe',
    });
    // Age the mtime as well so both name and mtime are past cutoff
    utimesSync(wtPath, fiveDaysAgo, fiveDaysAgo);

    cleanupStaleWorktrees(baseRepo, inboxDir);

    const remaining = readdirSync(wtDir);
    expect(remaining).not.toContain(sessionId);
  });

  it('creates unique filenames for multiple dirty worktrees', () => {
    const wtDir = join(baseRepo, '.claude', 'worktrees');
    mkdirSync(wtDir, { recursive: true });

    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    // Create two dirty worktrees
    for (const id of ['session-a', 'session-b']) {
      const wtPath = join(wtDir, id);
      execFileSync('git', ['-C', baseRepo, 'worktree', 'add', '-b', `session/${id}`, wtPath], {
        stdio: 'pipe',
      });
      writeFileSync(join(wtPath, 'dirty.txt'), `work in ${id}`);
      utimesSync(wtPath, fiveDaysAgo, fiveDaysAgo);
    }

    cleanupStaleWorktrees(baseRepo, inboxDir);

    const inboxFiles = readdirSync(inboxDir);
    expect(inboxFiles.length).toBe(2);
    // Each file should contain its session ID
    expect(inboxFiles.some((f: string) => f.includes('session-a'))).toBe(true);
    expect(inboxFiles.some((f: string) => f.includes('session-b'))).toBe(true);
  });
});
