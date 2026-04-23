import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkWorktreePolicy,
  getWorktreeGuardStats,
  resetWorktreeGuardStats,
} from '../src/worktree-guard.js';
import type { ManagedSession } from '../src/session-registry.js';
import type { OnDemandCreateFn } from '../src/worktree-guard.js';

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
    it('returns null when session has no worktrees', async () => {
      const empty = { worktreePaths: new Map() } as ManagedSession;
      const result = await checkWorktreePolicy(empty, 'Write', { path: '/anywhere' });
      expect(result).toBeNull();
    });
  });

  describe('Write/Edit tools', () => {
    it('allows writes inside a worktree', async () => {
      const result = await checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123/foo.ts',
      });
      expect(result).toBeNull();
    });

    it('allows writes inside secondary worktree', async () => {
      const result = await checkWorktreePolicy(session, 'Edit', {
        file_path: '/Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123/server/app.ts',
      });
      expect(result).toBeNull();
    });

    it('denies writes to main worktree with redirect', async () => {
      const result = await checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/some/file.ts',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
      expect(result).toContain('.claude/worktrees/2026-04-18-abc123/some/file.ts');
    });

    it('denies writes to secondary main worktree with redirect', async () => {
      const result = await checkWorktreePolicy(session, 'StrReplace', {
        path: '/Users/me/tools/mitzo/server/chat.ts',
      });
      expect(result).not.toBeNull();
      expect(result).toContain(
        'Use /Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123/server/chat.ts',
      );
    });

    it('denies writes to unrecognized paths', async () => {
      const result = await checkWorktreePolicy(session, 'Write', {
        path: '/tmp/random/file.ts',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
    });

    it('ignores relative paths', async () => {
      const result = await checkWorktreePolicy(session, 'Write', {
        path: 'relative/path.ts',
      });
      expect(result).toBeNull();
    });
  });

  describe('Read tools are not blocked', () => {
    it('allows Read on main worktree', async () => {
      const result = await checkWorktreePolicy(session, 'Read', {
        path: '/Users/me/redhat/mgmt/CONSTITUTION.md',
      });
      expect(result).toBeNull();
    });

    it('allows Grep on main worktree', async () => {
      const result = await checkWorktreePolicy(session, 'Grep', {
        pattern: 'foo',
        path: '/Users/me/tools/mitzo/server',
      });
      expect(result).toBeNull();
    });
  });

  describe('Shell/Bash tools', () => {
    it('allows shell commands inside worktree', async () => {
      const result = await checkWorktreePolicy(session, 'Bash', {
        command: 'cd /Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123 && git status',
      });
      expect(result).toBeNull();
    });

    it('denies shell commands referencing main worktree', async () => {
      const result = await checkWorktreePolicy(session, 'Bash', {
        command: 'git -C /Users/me/tools/mitzo commit -m "fix"',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('/Users/me/tools/mitzo');
      expect(result).toContain('outside session worktrees');
    });

    it('allows shell commands without absolute paths', async () => {
      const result = await checkWorktreePolicy(session, 'Bash', {
        command: 'npm test && git status',
      });
      expect(result).toBeNull();
    });
  });

  describe('EditNotebook tool', () => {
    it('uses target_notebook field', async () => {
      const result = await checkWorktreePolicy(session, 'EditNotebook', {
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

    it('increments denied on write violation', async () => {
      await checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/some/file.ts',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.denied).toBe(1);
      expect(stats.allowed).toBe(0);
    });

    it('increments allowed on successful check', async () => {
      await checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123/foo.ts',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.allowed).toBe(1);
      expect(stats.denied).toBe(0);
    });

    it('increments denied on shell violation', async () => {
      await checkWorktreePolicy(session, 'Bash', {
        command: 'git -C /Users/me/tools/mitzo commit -m "fix"',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.denied).toBe(1);
    });

    it('tracks multiple operations', async () => {
      await checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123/a.ts',
      });
      await checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/b.ts',
      });
      await checkWorktreePolicy(session, 'Edit', {
        file_path: '/Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123/c.ts',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.allowed).toBe(2);
      expect(stats.denied).toBe(1);
    });

    it('does not count read tools in stats', async () => {
      await checkWorktreePolicy(session, 'Read', {
        path: '/Users/me/redhat/mgmt/CONSTITUTION.md',
      });
      await checkWorktreePolicy(session, 'Grep', {
        pattern: 'foo',
        path: '/Users/me/tools/mitzo/server',
      });
      const stats = getWorktreeGuardStats();
      expect(stats.allowed).toBe(0);
      expect(stats.denied).toBe(0);
    });

    it('returns a copy, not a reference', async () => {
      const s1 = getWorktreeGuardStats();
      await checkWorktreePolicy(session, 'Write', {
        path: '/Users/me/redhat/mgmt/file.ts',
      });
      const s2 = getWorktreeGuardStats();
      expect(s1.denied).toBe(0);
      expect(s2.denied).toBe(1);
    });
  });

  describe('on-demand worktree creation', () => {
    it('triggers creation for write to configured repo without worktree', async () => {
      const sessionWithPrimaryOnly = makeSession({
        primary: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123',
      });

      const onDemandCreate: OnDemandCreateFn = vi.fn().mockResolvedValue({
        repoName: 'mitzo',
        worktreePath: '/Users/me/tools/mitzo/.claude/worktrees/2026-04-18-abc123',
      });

      const result = await checkWorktreePolicy(
        sessionWithPrimaryOnly as ManagedSession,
        'Write',
        { path: '/Users/me/tools/mitzo/server/chat.ts' },
        { onDemandCreate },
      );

      expect(onDemandCreate).toHaveBeenCalledWith('/Users/me/tools/mitzo/server/chat.ts');
      expect(result).not.toBeNull();
      expect(result).toContain('.claude/worktrees/2026-04-18-abc123/server/chat.ts');
      expect(sessionWithPrimaryOnly.worktreePaths.has('mitzo')).toBe(true);
    });

    it('returns hard deny when on-demand creation fails', async () => {
      const sessionWithPrimaryOnly = makeSession({
        primary: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123',
      });

      const onDemandCreate: OnDemandCreateFn = vi.fn().mockResolvedValue(null);

      const result = await checkWorktreePolicy(
        sessionWithPrimaryOnly as ManagedSession,
        'Write',
        { path: '/Users/me/tools/mitzo/server/chat.ts' },
        { onDemandCreate },
      );

      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
      expect(result).not.toContain('.claude/worktrees/');
    });

    it('falls through to hard deny when callback returns null for unknown path', async () => {
      const sessionWithPrimaryOnly = makeSession({
        primary: '/Users/me/redhat/mgmt/.claude/worktrees/2026-04-18-abc123',
      });

      const onDemandCreate: OnDemandCreateFn = vi.fn().mockResolvedValue(null);

      const result = await checkWorktreePolicy(
        sessionWithPrimaryOnly as ManagedSession,
        'Write',
        { path: '/tmp/random/file.ts' },
        { onDemandCreate },
      );

      expect(onDemandCreate).toHaveBeenCalledWith('/tmp/random/file.ts');
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
      expect(result).not.toContain('.claude/worktrees/');
    });
  });
});
