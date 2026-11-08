import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const probe = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../read-only-git.js', () => ({
  readOnlyGitExecutable() {
    probe.calls++;
    return '/usr/bin/git';
  },
}));
import {
  snapshotRepositoryTaskCheckout,
  validateRepositoryTaskCheckout,
} from '../repository-task-checkout.js';
import { findSessionRuntimeError } from '../session-runtime-error.js';
const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-git-preflight-')));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-C',
        root,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Offline',
        '-c',
        'user.email=offline@example.invalid',
        ...args,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    ).trim();
  git('init', '--template=', '-q', '-b', 'mitzo/fixture');
  git('commit', '--allow-empty', '-qm', 'base');
  return { root, git };
}
it.each(['standalone', 'linked'] as const)(
  'reports %s branch drift without losing the saved commit or weakening checkout custody',
  async (kind) => {
    const f = fixture();
    const cwd = kind === 'linked' ? join(f.root, 'task') : f.root;
    const branch = kind === 'linked' ? 'mitzo/linked' : 'mitzo/fixture';
    if (kind === 'linked') f.git('worktree', 'add', '-q', '-b', branch, cwd, 'HEAD');
    const identity = (path: string) => {
      const { dev, ino } = lstatSync(path);
      return { dev, ino };
    };
    const source =
      kind === 'linked'
        ? {
            repositoryId: 'offline',
            path: f.root,
            root: identity(f.root),
            commonDirectory: join(f.root, '.git'),
            commonRoot: identity(join(f.root, '.git')),
          }
        : undefined;
    const git = (...args: string[]) => f.git('-C', cwd, ...args);
    const retained = await snapshotRepositoryTaskCheckout(cwd, branch, source);
    git('checkout', '-qb', 'docs-reporting');
    git('commit', '--allow-empty', '-qm', 'saved work');
    const saved = git('rev-parse', 'HEAD');
    const error = await validateRepositoryTaskCheckout(cwd, retained).catch((error) => error);
    const failure = findSessionRuntimeError(error);
    expect(failure?.code).toBe('workspace_branch_changed');
    expect(failure?.publicMessage()).toContain('assigned task branch');
    expect(failure?.publicMessage()).not.toContain(f.root);
    expect(git('rev-parse', 'HEAD')).toBe(saved);
    // Recovery advances the original task branch, retaining both names and every commit.
    git('branch', '-f', branch, saved);
    git('checkout', '-q', branch);
    await expect(validateRepositoryTaskCheckout(cwd, retained)).resolves.toEqual(retained);
    expect(git('rev-parse', 'HEAD')).toBe(saved);
    expect(git('rev-parse', 'docs-reporting')).toBe(saved);
  },
);
afterEach(() => {
  probe.calls = 0;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it.each(['include', 'commondir', 'shallow', 'alternates'] as const)(
  'refuses standalone %s redirection before launching repository Git',
  async (change) => {
    const { root, git } = fixture();
    const outside = join(root, 'outside');
    writeFileSync(outside, git('rev-parse', 'HEAD') + '\n');
    if (change === 'include')
      appendFileSync(join(root, '.git', 'config'), '\n[include]\n path = ' + outside + '\n');
    if (change === 'commondir')
      writeFileSync(join(root, '.git', 'commondir'), join(root, '.git') + '\n');
    if (change === 'shallow') symlinkSync(outside, join(root, '.git', 'shallow'));
    if (change === 'alternates')
      writeFileSync(join(root, '.git', 'objects', 'info', 'alternates'), '/outside\n');
    await expect(snapshotRepositoryTaskCheckout(root, 'mitzo/fixture')).rejects.toThrow();
    expect(probe.calls).toBe(0);
  },
);
