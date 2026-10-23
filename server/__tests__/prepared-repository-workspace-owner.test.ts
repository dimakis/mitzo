import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotRepositoryTaskCheckout } from '../repository-task-checkout.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import { assertPreparedRepositoryTaskTopology } from '../prepared-repository-workspace-owner.js';

vi.setConfig({ testTimeout: 20000 }); // Two sequential real descriptor-read checks plus disposable Git setup.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
async function fixture(linkedSource = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-prepared-owner-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let source = join(root, 'source');
  const seed = source,
    task = join(root, 'repo-fixture');
  await mkdir(source);
  git(source, 'init', '--template=', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Offline');
  git(source, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'task.txt'), 'Original source');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'base');
  if (linkedSource) {
    source = join(root, 'selected-source');
    git(seed, 'worktree', 'add', '-qb', 'selected-source', source);
  }
  git(source, 'worktree', 'add', '-qb', 'mitzo/fixture', task);
  const identity = await snapshotRepositoryTaskCheckout(task, 'mitzo/fixture', {
    repositoryId: 'fixture',
    path: source,
    root: numeric((await fixtureReadAnchor(source)).identity),
    commonDirectory: join(seed, '.git'),
    commonRoot: numeric((await fixtureReadAnchor(join(seed, '.git'))).identity),
  });
  let live = true;
  const access = (deniedRoots: string[] = []) =>
    new LocalRepositoryReadAccess({
      deadline: Date.now() + 30000,
      deniedRoots,
      assertReadable: async (path) => {
        if (!live || deniedRoots.some((root) => path === root || path.startsWith(root + '/')))
          throw Error('Current read authority refused');
      },
      captureReadAnchor: fixtureReadAnchor,
    });
  return {
    root,
    source,
    task,
    identity,
    sourceGitDirectory: git(source, 'rev-parse', '--absolute-git-dir'),
    access,
    revoke: () => {
      live = false;
    },
  };
}
function numeric(identity: { dev: string; ino: string }) {
  return { dev: Number(identity.dev), ino: Number(identity.ino) };
}

// Controlled descriptor-relative Python fixture I/O only. Production must use
// the original native factory; setup Git above is never the validator executor.
it('validates fresh task topology and permits dirty work plus later real add/commit without creation-hash locks', async () => {
  const f = await fixture();
  await assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory);
  await writeFile(join(f.task, 'task.txt'), 'New task work');
  git(f.task, 'add', '.');
  git(f.task, 'commit', '-qm', 'task commit');
  await assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory);
  expect(await readFile(join(f.source, 'task.txt'), 'utf8')).toBe('Original source');
});
it.each(['redirect', 'commondir', 'head', 'root', 'denied', 'revoked'] as const)(
  'refuses changed qualified task %s topology or read owner',
  async (change) => {
    const f = await fixture();
    if (change === 'redirect')
      await writeFile(join(f.task, '.git'), `gitdir: ${join(f.root, 'outside')}\n`);
    if (change === 'commondir')
      await writeFile(join(f.identity.linkedGit!.directory, 'commondir'), '/outside\n');
    if (change === 'head')
      await writeFile(join(f.identity.linkedGit!.directory, 'HEAD'), 'ref: refs/heads/main\n');
    if (change === 'root') {
      await rename(f.task, f.task + '-retained');
      await symlink(f.task + '-retained', f.task);
    }
    if (change === 'revoked') f.revoke();
    await expect(
      assertPreparedRepositoryTaskTopology(
        f.access(change === 'denied' ? [f.identity.linkedGit!.directory] : []),
        f.identity,
        f.sourceGitDirectory,
      ),
    ).rejects.toThrow();
  },
);

it('refuses a retargeted linked source .git while the original source and common roots remain', async () => {
  const f = await fixture(true);
  await assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory);
  const other = join(f.root, 'other');
  await mkdir(other);
  git(other, 'init', '--template=', '-q', '-b', 'main');
  await writeFile(join(f.source, '.git'), `gitdir: ${join(other, '.git')}\n`);
  await expect(
    assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory),
  ).rejects.toThrow();
});
