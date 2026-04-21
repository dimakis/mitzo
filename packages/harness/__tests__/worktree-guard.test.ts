import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkWorktreePolicy,
  getWorktreeGuardStats,
  resetWorktreeGuardStats,
} from '../src/worktree-guard.js';
import type { ManagedSession } from '../src/session-registry.js';

function makeSession(
  worktrees: Record<string, string>,
): Pick<ManagedSession, 'worktreePaths' | 'sessionId'> {
  const map = new Map<string, { path: string; wtId: string }>();
  for (const [name, path] of Object.entries(worktrees)) {
    map.set(name, { path, wtId: '2026-04-18-abc123' });
  }
  return { worktreePaths: map, sessionId: '2026-04-18-abc123' } as ManagedSession;
}

const session = makeSession({
  primary: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123',
  mitzo: '/Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123',
  centaur: '/Users/me/projects/centaur/.claude/worktrees/2026-04-18-abc123',
});

describe('checkWorktreePolicy', () => {
  describe('no-op when no worktrees', () => {
    it('returns null when session has no worktrees', () => {
      const empty = { worktreePaths: new Map() } as ManagedSession;
      const result = checkWorktreePolicy(empty, 'Write', { path: '/anywhere' });
      expect(result).toBeNull();
    });
  });

  describe('Write/Edit tools', () => {
    it('allows writes inside a worktree', () => {
      const result = checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123/foo.ts',
      });
      expect(result).toBeNull();
    });

    it('allows writes inside secondary worktree', () => {
      const result = checkWorktreePolicy(session, 'Edit', {
        file_path: '/Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123/server/app.ts',
      });
      expect(result).toBeNull();
    });

    it('denies writes to main worktree with redirect', () => {
      const result = checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/some/file.ts',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
      expect(result).toContain('.claude/worktrees/2026-04-18-abc123/some/file.ts');
    });

    it('denies writes to secondary main worktree with redirect', () => {
      const result = checkWorktreePolicy(session, 'StrReplace', {
        path: '/Users/me/tools/mitzo/server/chat.ts',
      });
      expect(result).not.toBeNull();
      expect(result).toContain(
        'Use /Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123/server/chat.ts',
      );
    });

    it('denies writes to unrecognized paths', () => {
      const result = checkWorktreePolicy(session, 'Write', {
        path: '/tmp/random/file.ts',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
    });

    it('ignores relative paths', () => {
      const result = checkWorktreePolicy(session, 'Write', {
        path: 'relative/path.ts',
      });
      expect(result).toBeNull();
    });
  });

  describe('Read tools are not blocked', () => {
    it('allows Read on main worktree', () => {
      const result = checkWorktreePolicy(session, 'Read', {
        path: '/Users/me/redhat/mgmt/CONSTITUTION.md',
      });
      expect(result).toBeNull();
    });

    it('allows Grep on main worktree', () => {
      const result = checkWorktreePolicy(session, 'Grep', {
        pattern: 'foo',
        path: '/Users/me/tools/mitzo/server',
      });
      expect(result).toBeNull();
    });
  });

  describe('Shell/Bash tools', () => {
    it('allows shell commands inside worktree', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: 'cd /Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123 && git status',
      });
      expect(result).toBeNull();
    });

    it('denies shell commands referencing main worktree', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: 'git -C /Users/me/tools/mitzo commit -m "fix"',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('/Users/me/tools/mitzo');
      expect(result).toContain('outside session worktrees');
    });

    it('allows shell commands without absolute paths', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: 'npm test && git status',
      });
      expect(result).toBeNull();
    });
  });

  describe('EditNotebook tool', () => {
    it('uses target_notebook field', () => {
      const result = checkWorktreePolicy(session, 'EditNotebook', {
        target_notebook: '/Users/me/redhat/mgmt/jira_process/notebook.ipynb',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
    });
  });

  describe('stats tracking', () => {
    beforeEach(() => {
      resetWorktreeGuardStats();
    });

    it('increments denied on write violation', () => {
      checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/some/file.ts',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.denied).toBe(1);
      expect(stats.allowed).toBe(0);
    });

    it('increments allowed on successful check', () => {
      checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123/foo.ts',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.allowed).toBe(1);
      expect(stats.denied).toBe(0);
    });

    it('increments denied on shell violation', () => {
      checkWorktreePolicy(session, 'Bash', {
        command: 'git -C /Users/me/tools/mitzo commit -m "fix"',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.denied).toBe(1);
    });

    it('tracks multiple operations', () => {
      checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123/a.ts',
      });
      checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/b.ts',
      });
      checkWorktreePolicy(session, 'Edit', {
        file_path: '/Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123/c.ts',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.allowed).toBe(2);
      expect(stats.denied).toBe(1);
    });

    it('does not count read tools in stats', () => {
      checkWorktreePolicy(session, 'Read', {
        path: '/Users/me/redhat/mgmt/CONSTITUTION.md',
      });
      checkWorktreePolicy(session, 'Grep', {
        pattern: 'foo',
        path: '/Users/me/tools/mitzo/server',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.allowed).toBe(0);
      expect(stats.denied).toBe(0);
    });

    it('returns a copy, not a reference', () => {
      const s1 = getWorktreeGuardStats();
      checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/file.ts',
      });
      const s2 = getWorktreeGuardStats();
      expect(s1.denied).toBe(0);
      expect(s2.denied).toBe(1);
    });
  });
});
