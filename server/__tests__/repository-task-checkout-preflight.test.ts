import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
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
import { snapshotRepositoryTaskCheckout } from '../repository-task-checkout.js';
const roots: string[] = [];
afterEach(() => {
  probe.calls = 0;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it.each(['include', 'commondir', 'shallow', 'alternates'] as const)(
  'refuses standalone %s redirection before launching repository Git',
  async (change) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'task-git-preflight-')));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
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
    git('config', 'user.name', 'Offline');
    git('config', 'user.email', 'offline@example.invalid');
    git('commit', '--allow-empty', '-qm', 'base');
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
