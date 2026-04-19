import { describe, it, expect } from 'vitest';
import { checkWorktreePolicy } from '../src/worktree-guard.js';
import type { ManagedSession } from '../src/session-registry.js';

function makeSession(worktrees: Record<string, string>): Pick<ManagedSession, 'worktreePaths'> {
  const map = new Map<string, { path: string; wtId: string }>();
  for (const [name, path] of Object.entries(worktrees)) {
    map.set(name, { path, wtId: '2026-04-18-abc123' });
  }
  return { worktreePaths: map } as ManagedSession;
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

    it('catches single-quoted paths', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: "cat '/Users/me/redhat/mgmt/secret.env'",
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
    });

    it('catches redirect operators', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: 'echo secret >/Users/me/redhat/mgmt/file.txt',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
    });

    it('catches append redirect operators', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: 'echo data >>/Users/me/tools/mitzo/log.txt',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
    });

    it('denies paths outside all known repos', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: 'echo secret > /tmp/exfil.txt',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
    });

    it('handles paths with + and ~ characters', () => {
      const result = checkWorktreePolicy(session, 'Bash', {
        command: 'ls /Users/me/redhat/mgmt/dir+name/file~backup.ts',
      });
      expect(result).not.toBeNull();
      expect(result).toContain('outside session worktrees');
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
});
