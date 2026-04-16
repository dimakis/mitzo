import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync, utimesSync } from 'fs';
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

import { cleanupStaleWorktrees } from '../worktree.js';

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
