import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import type { LocalRepositoryReadAuthority } from '../local-repository-read-access.js';

vi.setConfig({ testTimeout: 30000 });
let root: string, source: string, taskRoot: string, id: string;
const git = (...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      source,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
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
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-allocation-facts-')));
  source = join(root, 'source');
  taskRoot = join(root, 'owned-task-root');
  id = randomUUID();
  await mkdir(source);
  await mkdir(taskRoot);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'source.txt'), 'SOURCE BYTES\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function owner(deniedRoots: readonly string[] = []) {
  return {
    deniedRoots,
    captureReadAnchor: vi.fn(fixtureReadAnchor),
    assertReadable: vi.fn(async () => {}),
    signal: AbortSignal.timeout(30000),
    deadline: Date.now() + 30000,
  } satisfies LocalRepositoryReadAuthority;
}
const input = () => ({ workspaceId: id, sourcePath: source, taskRoot });
const task = () => join(taskRoot, `repo-${id}`);
// Explicit standalone descriptor owner fixtures only. The facts are custody
// evidence, never signed-native authority or a registered Prepare implementation.
it('captures finite original root/parent/absence facts without creating any source or destination entry', async () => {
  const index = await readFile(join(source, '.git', 'index'));
  const head = git('rev-parse', 'HEAD');
  const held = await captureLocalRepositoryAllocationFacts(owner(), input());
  expect(held.facts.workspaceId).toBe(id);
  expect(held.facts.baseOid).toBe(head);
  expect(held.facts.directories.map((step) => step.directory)).toEqual(
    expect.arrayContaining([
      task(),
      join(source, '.git', 'worktrees'),
      join(source, '.git', 'refs', 'heads', 'mitzo'),
      join(source, '.git', 'logs', 'refs', 'heads', 'mitzo'),
    ]),
  );
  expect(held.facts.directories.length).toBeLessThanOrEqual(9);
  expect(Object.isFrozen(held.facts)).toBe(true);
  expect(Object.isFrozen(held.facts.directories[0])).toBe(true);
  expect(held.factsSha256).toMatch(/^[a-f0-9]{64}$/);
  await held.verify();
  await expect(lstat(task())).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(source, '.git', 'worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
  expect(git('rev-parse', 'HEAD')).toBe(head);
});
it('expresses missing fixed namespace parents as finite dependencies on prior exclusive creates', async () => {
  git('pack-refs', '--all', '--prune');
  await rm(join(source, '.git', 'refs'), { recursive: true });
  await rm(join(source, '.git', 'logs'), { recursive: true });
  const held = await captureLocalRepositoryAllocationFacts(owner(), input());
  const planned = new Set<string>();
  for (const step of held.facts.directories) {
    if (step.parent.kind === 'created') expect(planned.has(step.parent.directory)).toBe(true);
    else expect(step.parent.identity.ino).toMatch(/^\d+$/);
    planned.add(step.directory);
  }
  expect(held.facts.directories).toHaveLength(9);
  await expect(lstat(join(source, '.git', 'refs'))).rejects.toMatchObject({ code: 'ENOENT' });
  await held.verify();
});
it('refuses a target branch retained only in packed refs instead of inventing absence', async () => {
  git('branch', `mitzo/repo-${id}`);
  git('pack-refs', '--all', '--prune');
  await expect(
    lstat(join(source, '.git', 'refs', 'heads', 'mitzo', `repo-${id}`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  const before = await readFile(join(source, '.git', 'packed-refs'));
  await expect(captureLocalRepositoryAllocationFacts(owner(), input())).rejects.toThrow(
    'Local repository allocation facts unavailable',
  );
  expect(await readFile(join(source, '.git', 'packed-refs'))).toEqual(before);
  await expect(lstat(task())).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['ancestor', 'descendant'] as const)(
  'refuses a packed %s branch namespace conflict without creating loose entries',
  async (kind) => {
    const branch = kind === 'ancestor' ? 'mitzo' : `mitzo/repo-${id}/child`;
    git('branch', branch);
    git('pack-refs', '--all', '--prune');
    await rm(join(source, '.git', 'refs', 'heads', 'mitzo'), { recursive: true, force: true });
    // Remove loose/log namespace collisions so ONLY the packed ref conflicts.
    await rm(join(source, '.git', 'logs', 'refs', 'heads', 'mitzo'), {
      recursive: true,
      force: true,
    });
    const packed = await readFile(join(source, '.git', 'packed-refs'));
    await expect(captureLocalRepositoryAllocationFacts(owner(), input())).rejects.toThrow(
      'Local repository allocation facts unavailable',
    );
    expect(await readFile(join(source, '.git', 'packed-refs'))).toEqual(packed);
    await expect(lstat(task())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(source, '.git', 'refs', 'heads', 'mitzo'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);
it.each(['task', 'admin', 'ref-lock', 'log-lock'] as const)(
  'refuses a foreign existing %s claim and preserves its bytes',
  async (kind) => {
    const directory =
      kind === 'task'
        ? task()
        : kind === 'admin'
          ? join(source, '.git', 'worktrees', `repo-${id}`)
          : kind === 'ref-lock'
            ? join(source, '.git', 'refs', 'heads', 'mitzo')
            : join(source, '.git', 'logs', 'refs', 'heads', 'mitzo');
    await mkdir(directory, { recursive: true });
    const file =
      kind === 'task' || kind === 'admin'
        ? join(directory, 'foreign-witness')
        : join(directory, `repo-${id}.lock`);
    await writeFile(file, 'FOREIGN BYTES');
    expect((await lstat(directory)).isDirectory()).toBe(true);
    const captured = captureLocalRepositoryAllocationFacts(owner(), input());
    await captured.catch(() => {});
    expect(await readFile(file, 'utf8')).toBe('FOREIGN BYTES');
    await expect(captured).rejects.toThrow('Local repository allocation facts unavailable');
    expect(await readFile(file, 'utf8')).toBe('FOREIGN BYTES');
  },
);
it('refuses an explicitly denied required namespace before claiming absence and discloses no denied path', async () => {
  const denied = join(source, '.git', 'worktrees');
  await mkdir(denied);
  const error = await captureLocalRepositoryAllocationFacts(owner([denied]), input()).catch(
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({ message: 'Local repository allocation facts unavailable' });
  expect(String(error)).not.toContain(denied);
});
it('detects an external namespace arrival before permission use and leaves it untouched', async () => {
  const held = await captureLocalRepositoryAllocationFacts(owner(), input());
  await mkdir(join(source, '.git', 'worktrees'));
  await expect(held.verify()).rejects.toThrow('Local repository allocation facts unavailable');
  expect((await lstat(join(source, '.git', 'worktrees'))).isDirectory()).toBe(true);
  await expect(lstat(task())).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects credential paths and malformed identity intent before touching any source anchor', async () => {
  const authority = owner();
  for (const invalid of [
    { ...input(), sourcePath: join(root, '.aws', 'private') },
    { ...input(), workspaceId: 'not-an-owned-id' },
    { ...input(), taskRoot: taskRoot + '/..' },
  ])
    await expect(captureLocalRepositoryAllocationFacts(authority, invalid)).rejects.toThrow(
      'Local repository allocation facts unavailable',
    );
  expect(authority.captureReadAnchor).not.toHaveBeenCalled();
  expect(authority.assertReadable).not.toHaveBeenCalled();
});
it('refuses a task root inside the source before reading it or preparing nested source effects', async () => {
  const authority = owner();
  const index = await readFile(join(source, '.git', 'index'));
  await expect(
    captureLocalRepositoryAllocationFacts(authority, { ...input(), taskRoot: source }),
  ).rejects.toThrow('Local repository allocation facts unavailable');
  expect(authority.captureReadAnchor).not.toHaveBeenCalled();
  expect(authority.assertReadable).not.toHaveBeenCalled();
  expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
  await expect(lstat(join(source, `repo-${id}`))).rejects.toMatchObject({ code: 'ENOENT' });
});
