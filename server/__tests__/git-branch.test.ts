import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => {
    throw new Error('no process effects');
  }),
}));
import { isGitBranchName } from '../git-branch.js';

it('matches literal Git branch syntax without spawning a process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const names = [
    'main',
    'release+2026',
    'release@home',
    'é/版本',
    '@',
    'foo..bar',
    'foo.lock/bar',
    '.foo',
    'foo/.bar',
    'foo.',
    'foo//bar',
    'foo/',
    '/foo',
    '-foo',
    'foo/-bar',
    'foo\\bar',
    'foo bar',
    'foo~bar',
    'foo^bar',
    'foo:bar',
    'foo?bar',
    'foo*bar',
    'foo[bar',
    'foo@{bar',
    'foo\u007fbar',
    'foo\nbar',
    'HEAD',
    'refs/heads/foo',
    'foo..',
    'foo.lock',
    'foo.lock.lock',
    'foo/bar.',
  ];
  const expected = names.map(
    (name) =>
      actual.spawnSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' })
        .status === 0,
  );
  expect(names.map(isGitBranchName)).toEqual(expected);
  expect(spawnSync).not.toHaveBeenCalled();
});
