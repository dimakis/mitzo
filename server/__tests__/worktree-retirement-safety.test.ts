import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStaleWorktrees, removeWorktree } from '../worktree.js';

vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-retirement-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Offline');
  git(root, 'config', 'user.email', 'offline@example.invalid');
  git(root, 'commit', '--allow-empty', '-qm', 'fixture');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function worktree(name = 'unused') {
  const path = join(root, '.claude', 'worktrees', name);
  mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', `session/${name}`, path);
  const before = new Date(Date.now() - 5 * 86400000);
  utimesSync(path, before, before);
  return path;
}
it('preserves dirty stale work without an inbox even under legacy execute policy', () => {
  const path = worktree();
  writeFileSync(join(path, 'untracked.txt'), 'private work');
  const before = new Date(Date.now() - 5 * 86400000);
  utimesSync(path, before, before);
  expect(cleanupStaleWorktrees(root, undefined, undefined, 'execute').removed).toBe(0);
  expect(readFileSync(join(path, 'untracked.txt'), 'utf8')).toBe('private work');
});
it('does not publish, commit or remove dirty work during periodic inventory', () => {
  const path = worktree();
  writeFileSync(join(path, 'untracked.txt'), 'private work');
  const before = new Date(Date.now() - 5 * 86400000);
  utimesSync(path, before, before);
  const head = git(path, 'rev-parse', 'HEAD');
  cleanupStaleWorktrees(root, join(root, 'inbox'), undefined, 'execute');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(join(path, 'untracked.txt'))).toBe(true);
});
it('does not infer retirement authority from clean status and age', () => {
  const path = worktree();
  writeFileSync(join(path, 'unique.txt'), 'unpublished commit');
  git(path, 'add', 'unique.txt');
  git(path, 'commit', '-qm', 'unpublished');
  writeFileSync(join(path, '.gitignore'), 'ignored.bin\n');
  git(path, 'add', '.gitignore');
  git(path, 'commit', '-qm', 'ignore');
  writeFileSync(join(path, 'ignored.bin'), 'irreplaceable ignored output');
  const before = new Date(Date.now() - 5 * 86400000);
  utimesSync(path, before, before);
  const result = cleanupStaleWorktrees(root, undefined, undefined, 'execute');
  expect(result.removed).toBe(0);
  expect(readFileSync(join(path, 'ignored.bin'), 'utf8')).toContain('irreplaceable');
});
it('does not force-remove a dirty worktree when normal Git removal refuses', () => {
  const path = worktree();
  writeFileSync(join(path, 'private.txt'), 'keep');
  expect(removeWorktree('unused', root)).toBe(false);
  expect(readFileSync(join(path, 'private.txt'), 'utf8')).toBe('keep');
});
