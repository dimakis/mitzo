import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktree, createWorktreeAsync } from '../worktree.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shared-worktree-base-')));
  roots.push(root);
  const publisher = join(root, 'publisher'),
    repo = join(root, 'local'),
    remote = join(root, 'upstream.git');
  execFileSync('git', ['init', '-q', '-b', 'main', publisher]);
  git(publisher, 'config', 'user.name', 'Offline');
  git(publisher, 'config', 'user.email', 'offline@example.invalid');
  writeFileSync(join(publisher, 'code.txt'), 'base');
  git(publisher, 'add', '.');
  git(publisher, 'commit', '-qm', 'base');
  execFileSync('git', ['clone', '-q', '--bare', publisher, remote]);
  execFileSync('git', ['clone', '-q', remote, repo]);
  git(publisher, 'remote', 'add', 'origin', remote);
  const previous = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(publisher, 'code.txt'), 'latest main');
  git(publisher, 'add', '.');
  git(publisher, 'commit', '-qm', 'advance main');
  git(publisher, 'push', '-q', 'origin', 'main');
  const latest = git(publisher, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'unfinished.txt'), 'preserve');
  return { repo, remote, previous, latest };
}
for (const [name, create] of [
  ['synchronous', createWorktree],
  ['asynchronous', createWorktreeAsync],
] as const) {
  it(`${name} local worktree creation fetches current upstream main for every caller`, async () => {
    const f = fixture();
    const path = await create('new-session', f.repo);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(f.latest);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.previous);
    expect(git(f.repo, 'status', '--short')).toContain('unfinished.txt');
    git(f.repo, 'remote', 'set-url', 'origin', join(f.remote, 'unavailable'));
    writeFileSync(join(path, 'code.txt'), 'unfinished session');
    expect(await create('new-session', f.repo)).toBe(path);
    expect(git(path, 'diff')).toContain('unfinished session');
  });
  it(`${name} explicit agent ref overrides latest main, and an unavailable upstream never silently uses stale main`, async () => {
    const f = fixture();
    git(f.repo, 'remote', 'set-url', 'origin', join(f.remote, 'unavailable'));
    await expect(Promise.resolve().then(() => create('new-session', f.repo))).rejects.toThrow();
    const path = await create('requested-session', f.repo, { startPoint: f.previous });
    expect(git(path, 'rev-parse', 'HEAD')).toBe(f.previous);
  });
}
