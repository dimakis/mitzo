import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkWorktreePolicy as checkWorktreePolicyWithProbe,
  getWorktreeGuardStats,
  resetWorktreeGuardStats,
} from '../src/worktree-guard.js';
import type { ManagedSession } from '../src/session-registry.js';
import type { OnDemandCreateFn, PathCreationProbe } from '../src/worktree-guard.js';

/** Only `/` exists and it is writable: every shell path stays creatable, as before the probe. */
const writableRootOnly: PathCreationProbe = {
  exists: async (path) => path === '/',
  realpath: async (path) => path,
  isWritable: async () => true,
};

/** Default the probe so the fixture paths are judged independently of the host filesystem. */
function checkWorktreePolicy(
  ...[current, toolName, toolInput, opts]: Parameters<typeof checkWorktreePolicyWithProbe>
) {
  return checkWorktreePolicyWithProbe(current, toolName, toolInput, {
    pathProbe: writableRootOnly,
    ...opts,
  });
}

function fakeFs(layout: {
  writable?: string[];
  readOnly?: string[];
  symlinks?: Record<string, string>;
}): PathCreationProbe {
  const writable = new Set(layout.writable ?? []);
  const readOnly = new Set(layout.readOnly ?? []);
  const symlinks = layout.symlinks ?? {};
  const present = (path: string) => writable.has(path) || readOnly.has(path);
  return {
    exists: async (path) => present(path) || path in symlinks,
    realpath: async (path) => {
      const target = symlinks[path] ?? path;
      if (!present(target)) throw Object.assign(new Error(`ENOENT ${target}`), { code: 'ENOENT' });
      return target;
    },
    isWritable: async (path) => writable.has(path),
  };
}

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

    it('allows an absolute executable while still guarding its path arguments', async () => {
      const executableOnly = await checkWorktreePolicy(session, 'Bash', {
        command: '/opt/homebrew/bin/gws drive files list --params \'{"pageSize":1}\'',
      });
      const outsideArgument = await checkWorktreePolicy(session, 'Bash', {
        command: '/usr/bin/git -C /Users/me/tools/mitzo status',
      });

      expect(executableOnly).toBeNull();
      expect(outsideArgument).toContain('/Users/me/tools/mitzo');
    });

    it('denies an executable from an external repository', async () => {
      const result = await checkWorktreePolicy(session, 'Bash', {
        command: '/Users/me/tools/mitzo/scripts/mutate-main --force',
      });

      expect(result).toContain('/Users/me/tools/mitzo/scripts/mutate-main');
      expect(result).toContain('outside session worktrees');
    });

    it('does not trust arbitrary Homebrew executables', async () => {
      const result = await checkWorktreePolicy(session, 'Bash', {
        command: '/opt/homebrew/bin/mutate-main --force',
      });

      expect(result).toContain('/opt/homebrew/bin/mutate-main');
      expect(result).toContain('outside session worktrees');
    });

    it('trusts fixed system gh executables while still guarding their path arguments', async () => {
      for (const gh of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
        expect(
          await checkWorktreePolicy(session, 'Bash', {
            command: `${gh} repo clone owner/repo .claude/repository-tasks/repo`,
          }),
        ).toBeNull();
        expect(
          await checkWorktreePolicy(session, 'Bash', {
            command: `${gh} repo clone owner/repo /Users/me/tools/mitzo/clone`,
          }),
        ).toContain('/Users/me/tools/mitzo/clone');
      }
      expect(
        await checkWorktreePolicy(session, 'Bash', { command: '/Users/me/bin/gh pr list' }),
      ).toContain('/Users/me/bin/gh');
    });

    it('ignores standard device streams but not other device paths', async () => {
      expect(
        await checkWorktreePolicy(session, 'Bash', {
          command:
            'git fetch > /dev/null 2> /dev/stderr && cat /dev/stdin | tee /dev/stdout "/dev/null"',
        }),
      ).toBeNull();
      expect(
        await checkWorktreePolicy(session, 'Bash', { command: 'cat /dev/null/../../etc/hosts' }),
      ).toContain('/dev/null/../../etc/hosts');
      expect(await checkWorktreePolicy(session, 'Bash', { command: 'dd of=/dev/disk2' })).toContain(
        '/dev/disk2',
      );
    });
  });

  describe('shell paths this process cannot create', () => {
    const rootOnly = fakeFs({ readOnly: ['/'] });
    const host = fakeFs({
      readOnly: ['/', '/Users', '/opt', '/etc', '/etc/hosts'],
      writable: ['/tmp', '/Users/x', '/Users/x/other'],
      symlinks: { '/opt/link': '/Users/x/other', '/opt/dangling': '/Users/x/other/missing' },
    });
    const refusal = (path: string) =>
      `Shell command references ${path} is outside session worktrees. Check $MITZO_REPO_* env vars for correct paths.`;

    it('allows an HTTP API path in a heredoc script when its nearest existing ancestor is unwritable', async () => {
      const command = [
        "python3 - <<'EOF'",
        'import requests',
        'r = requests.get("/traces/abc")',
        'print(r.status_code, 10 /2)',
        'EOF',
      ].join('\n');

      expect(await checkWorktreePolicy(session, 'Bash', { command }, { pathProbe: rootOnly })).toBe(
        null,
      );
    });

    it('still refuses paths whose nearest existing ancestor is writable', async () => {
      expect(
        await checkWorktreePolicy(
          session,
          'Bash',
          { command: 'echo x > /tmp/out' },
          { pathProbe: host },
        ),
      ).toBe(refusal('/tmp/out'));
      expect(
        await checkWorktreePolicy(
          session,
          'Bash',
          { command: `python3 -c "open('/Users/x/other/f','w')"` },
          { pathProbe: host },
        ),
      ).toBe(refusal('/Users/x/other/f'));
      expect(
        await checkWorktreePolicy(
          session,
          'Bash',
          { command: 'mkdir -p /Users/x/new/deep/dir' },
          { pathProbe: host },
        ),
      ).toBe(refusal('/Users/x/new/deep/dir'));
    });

    it('follows symlinked ancestors and refuses dangling symlinks', async () => {
      for (const path of ['/opt/link/new', '/opt/dangling', '/opt/dangling/f']) {
        expect(
          await checkWorktreePolicy(
            session,
            'Bash',
            { command: `touch ${path}` },
            { pathProbe: host },
          ),
        ).toBe(refusal(path));
      }
      expect(
        await checkWorktreePolicy(
          session,
          'Bash',
          { command: 'touch /opt/missing/f' },
          { pathProbe: host },
        ),
      ).toBeNull();
    });

    it('keeps refusing existing paths even under unwritable directories', async () => {
      expect(
        await checkWorktreePolicy(
          session,
          'Bash',
          { command: 'cat /etc/hosts' },
          { pathProbe: host },
        ),
      ).toBe(refusal('/etc/hosts'));
    });

    it.each([
      ['quote concatenation', 'cd "/tm"p && touch out', '/tm'],
      ['unquoted concatenation', 'cd /tm"p" && touch out', '/tm'],
      ['variable prefix', 'echo x > $HOME"/other/f"', '/other/f'],
      ['tilde prefix', 'echo x > ~"/other/f"', '/other/f'],
      ['glob', 'echo x > /t*/out', '/t'],
      ['expansion inside double quotes', 'echo x > "/tm$P/out"', '/tm$P/out'],
      ['parent segments', 'echo x > /nope/../tmp/out', '/nope/../tmp/out'],
      ['privilege escalation', 'echo x | sudo tee /newdir/f', '/newdir/f'],
    ])('refuses non-literal or privileged references (%s)', async (_case, command, path) => {
      expect(await checkWorktreePolicy(session, 'Bash', { command }, { pathProbe: rootOnly })).toBe(
        refusal(path),
      );
    });

    it('refuses when the probe fails unexpectedly', async () => {
      const failing: PathCreationProbe = {
        ...rootOnly,
        exists: async () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      };
      expect(
        await checkWorktreePolicy(
          session,
          'Bash',
          { command: 'curl -s localhost/x -o /traces/out' },
          { pathProbe: failing },
        ),
      ).toBe(refusal('/traces/out'));
    });

    it('does not offer on-demand worktree creation for uncreatable paths', async () => {
      const onDemandCreate = vi.fn();
      expect(
        await checkWorktreePolicy(
          session,
          'Bash',
          { command: 'echo \'get("/traces/abc")\'' },
          { pathProbe: rootOnly, onDemandCreate },
        ),
      ).toBeNull();
      expect(onDemandCreate).not.toHaveBeenCalled();
    });

    describe('default filesystem probe', () => {
      let base = '';
      beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'worktree-guard-'));
        await mkdir(join(base, 'locked'));
        await mkdir(join(base, 'open'));
        await chmod(join(base, 'locked'), 0o555);
      });
      afterEach(async () => {
        await chmod(join(base, 'locked'), 0o755);
        await rm(base, { recursive: true, force: true });
      });

      it.skipIf(process.getuid?.() === 0)(
        'probes the real filesystem when no probe is injected',
        async () => {
          const locked = join(base, 'locked', 'missing', 'f');
          const open = join(base, 'open', 'missing', 'f');
          expect(
            await checkWorktreePolicyWithProbe(session, 'Bash', { command: `touch ${locked}` }),
          ).toBeNull();
          expect(
            await checkWorktreePolicyWithProbe(session, 'Bash', { command: `touch ${open}` }),
          ).toBe(refusal(open));
        },
      );
    });
  });

  describe('out-of-root hint without on-demand creation', () => {
    const hint = 'Clone it under .claude/repository-tasks/<name> instead.';
    it('uses the hint for unmapped shell and write paths but keeps worktree redirects', async () => {
      const shell = await checkWorktreePolicy(
        session,
        'Bash',
        { command: 'ls /Users/me/projects/other/src' },
        { outOfRootHint: hint },
      );
      expect(shell).toContain('/Users/me/projects/other/src is outside session worktrees');
      expect(shell).toContain(hint);
      expect(shell).not.toContain('MITZO_REPO_');
      const write = await checkWorktreePolicy(
        session,
        'Write',
        { file_path: '/Users/me/projects/other/file.ts' },
        { outOfRootHint: hint },
      );
      expect(write).toContain(hint);
      const mapped = await checkWorktreePolicy(
        session,
        'Write',
        { file_path: '/Users/me/redhat/mgmt/some/file.ts' },
        { outOfRootHint: hint },
      );
      expect(mapped).toContain('.claude/worktrees/2026-04-18-abc123/some/file.ts');
      expect(mapped).not.toContain(hint);
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
    it.each(['Write', 'Bash'])(
      'never replaces an admitted mapping after a late %s preparation',
      async (toolName) => {
        const current = makeSession({ primary: '/mgmt/.claude/worktrees/admitted' });
        const create: OnDemandCreateFn = vi.fn(async () => ({
          repoName: 'primary',
          worktreePath: '/mgmt/.claude/worktrees/replacement',
        }));
        const result = await checkWorktreePolicy(
          current as ManagedSession,
          toolName,
          toolName === 'Write'
            ? { file_path: '/mgmt/app.txt' }
            : { command: 'cd /mgmt && touch app.txt' },
          { onDemandCreate: create },
        );
        expect(result).not.toBeNull();
        expect(current.worktreePaths.get('primary')?.path).toBe('/mgmt/.claude/worktrees/admitted');
      },
    );

    it.each(['Write', 'Bash'])(
      'refuses cancelled %s preparation before acquisition',
      async (toolName) => {
        const current = makeSession({ primary: '/mgmt/.claude/worktrees/original' });
        const controller = new AbortController();
        controller.abort(Error('Original invocation cancelled'));
        const create = vi.fn();
        await expect(
          checkWorktreePolicy(
            current as ManagedSession,
            toolName,
            toolName === 'Write'
              ? { file_path: '/target/app.txt' }
              : { command: 'cd /target && touch app.txt' },
            { onDemandCreate: create, signal: controller.signal },
          ),
        ).rejects.toThrow('Original invocation cancelled');
        expect(create).not.toHaveBeenCalled();
        expect([...current.worktreePaths.keys()]).toEqual(['primary']);
      },
    );

    it.each(['Write', 'Bash'])(
      'does not adopt a late %s preparation after cancellation',
      async (toolName) => {
        const current = makeSession({ primary: '/mgmt/.claude/worktrees/original' });
        const controller = new AbortController();
        const create: OnDemandCreateFn = vi.fn(async (_path, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(Error('Original invocation cancelled'));
          return { repoName: 'target', worktreePath: '/target/.claude/worktrees/original' };
        });
        await expect(
          checkWorktreePolicy(
            current as ManagedSession,
            toolName,
            toolName === 'Write'
              ? { file_path: '/target/app.txt' }
              : { command: 'cd /target && touch app.txt' },
            { onDemandCreate: create, signal: controller.signal },
          ),
        ).rejects.toThrow('Original invocation cancelled');
        expect(create).toHaveBeenCalledTimes(1);
        expect([...current.worktreePaths.keys()]).toEqual(['primary']);
      },
    );

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
