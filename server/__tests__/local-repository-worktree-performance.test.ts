import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertLocalRepository,
  captureLocalRepository,
  inspectLocalRepositoryWorktree,
} from '../local-repository-worktree.js';

vi.mock('node:child_process', { spy: true });
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.clearAllMocks();
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-check-budget-')));
  roots.push(root);
  const repo = join(root, 'repo');
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Offline',
        '-c',
        'user.email=offline@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'file.txt'), 'original');
  git('add', 'file.txt');
  git('commit', '-qm', 'base');
  const captured = await captureLocalRepository('primary', repo, new AbortController().signal);
  const checkout = join(root, 'checkout');
  git('worktree', 'add', '-q', '-b', 'mitzo/test', checkout);
  vi.mocked(execFileSync).mockClear();
  return { ...captured, repo, checkout, git };
}

it('checks source identity and commit type in one process without dropping missing-object checks', async () => {
  const f = await fixture();
  assertLocalRepository(f.localSource, f.repo, f.baseOid);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(() => assertLocalRepository(f.localSource, f.repo, '0'.repeat(40))).toThrow();
});

it('checks linked identity, branch and commit type in one process and rejects a non-commit HEAD', async () => {
  const f = await fixture();
  const linked = inspectLocalRepositoryWorktree(f.checkout, f.localSource, 'mitzo/test');
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(() =>
    inspectLocalRepositoryWorktree(f.checkout, f.localSource, 'mitzo/foreign'),
  ).toThrow();
  const blob = f.git('rev-parse', 'HEAD:file.txt');
  writeFileSync(join(f.localSource.commonDirectory, 'refs', 'heads', 'mitzo', 'test'), blob + '\n');
  expect(() => inspectLocalRepositoryWorktree(f.checkout, f.localSource, 'mitzo/test')).toThrow();
  expect(linked).not.toBe(f.localSource.commonDirectory);
});
