import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import {
  captureQualifiedLocalRepositoryTask,
  type QualifiedLocalRepositoryPublication,
} from '../qualified-local-repository-task.js';

// Explicit disposable Git-created worktree for READ-ONLY phase/custody checks.
// Fixture Git effects are not the product actor or evidence of Prepare authority.
vi.setConfig({ testTimeout: 30000 });
let root: string, source: string, taskRoot: string, task: string, id: string;
const git = (...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', source, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
const authority = () => ({
  deniedRoots: [],
  deadline: Date.now() + 30000,
  assertReadable: async () => {},
  captureReadAnchor: fixtureReadAnchor,
});
const identity = async (path: string) => {
  const info = await lstat(path);
  return { dev: String(info.dev), ino: String(info.ino) };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-qualified-task-')));
  source = join(root, 'source');
  taskRoot = join(root, 'tasks');
  id = randomUUID();
  task = join(taskRoot, `repo-${id}`);
  await mkdir(source);
  await mkdir(taskRoot);
  git('init', '-q', '-b', 'base');
  git('config', 'user.name', 'Offline fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'source.txt'), 'COMMITTED\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const original = await captureLocalRepositoryAllocationFacts(authority(), {
    workspaceId: id,
    sourcePath: source,
    taskRoot,
  });
  git('worktree', 'add', '-q', '-b', original.facts.featureBranch, task, original.facts.baseOid);
  const admin = join(source, '.git', 'worktrees', `repo-${id}`);
  const dirs = [...original.facts.directories.map((step) => step.directory), admin];
  const paths = [
    join(admin, 'HEAD'),
    join(admin, 'commondir'),
    join(admin, 'gitdir'),
    join(admin, 'index'),
    join(source, '.git', 'refs', 'heads', original.facts.featureBranch),
    join(task, '.git'),
  ];
  const publication: QualifiedLocalRepositoryPublication = {
    version: 1,
    directories: await Promise.all(
      dirs.map(async (directory) => ({ directory, identity: await identity(directory) })),
    ),
    files: await Promise.all(
      paths.map(async (file_path) => {
        const bytes = await readFile(file_path);
        return {
          file_path,
          identity: await identity(file_path),
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }),
    ),
  };
  return {
    facts: original.facts,
    publication,
    admin,
    access: () => new LocalRepositoryReadAccess(authority()),
  };
}
it('captures physical task/linkage only from known-created publication IDs and current anchored reads', async () => {
  const f = await fixture();
  const index = await readFile(join(source, '.git', 'index'));
  const taskIdentity = await captureQualifiedLocalRepositoryTask(
    f.access(),
    f.facts,
    f.publication,
  );
  expect(taskIdentity.directory).toBe(task);
  expect(taskIdentity.featureBranch).toBe(f.facts.featureBranch);
  expect(taskIdentity.linkedGit?.directory).toBe(f.admin);
  expect(Object.isFrozen(taskIdentity)).toBe(true);
  expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
});
it.each(['reference', 'marker', 'admin'] as const)(
  'refuses same-path replaced %s custody even with identical bytes',
  async (kind) => {
    const f = await fixture();
    const path =
      kind === 'reference'
        ? join(source, '.git', 'refs', 'heads', f.facts.featureBranch)
        : kind === 'marker'
          ? join(task, '.git')
          : f.admin;
    if (kind === 'admin') {
      await rename(path, path + '-retained');
      await mkdir(path);
    } else {
      const bytes = await readFile(path);
      await rename(path, path + '-retained');
      await writeFile(path, bytes);
    }
    await expect(
      captureQualifiedLocalRepositoryTask(f.access(), f.facts, f.publication),
    ).rejects.toThrow('Qualified repository task unavailable');
  },
);
it('refuses changed branch bytes before exposure while retaining every source/task entry', async () => {
  const f = await fixture();
  const path = join(source, '.git', 'refs', 'heads', f.facts.featureBranch);
  await writeFile(path, '1'.repeat(40) + '\n');
  await expect(
    captureQualifiedLocalRepositoryTask(f.access(), f.facts, f.publication),
  ).rejects.toThrow('Qualified repository task unavailable');
  expect(await readFile(path, 'utf8')).toBe('1'.repeat(40) + '\n');
  expect(await readFile(join(task, 'source.txt'), 'utf8')).toBe('COMMITTED\n');
});
