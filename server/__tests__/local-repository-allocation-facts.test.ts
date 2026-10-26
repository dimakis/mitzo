import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import type { LocalRepositoryReadAuthority } from '../local-repository-read-access.js';
import { executeNativeAnchoredReadOperation } from '../native-file-operation.js';

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
it('captures initial listings only for the two already-pinned roots through the current batch port', async () => {
  const authority: LocalRepositoryReadAuthority = owner();
  const batches: string[][] = [];
  authority.executeDirectoryVerification = async (requests, signal, timeout) => {
    batches.push(requests.map((request) => request.file_path));
    return Promise.all(
      requests.map((request) => executeNativeAnchoredReadOperation(request, signal, timeout)),
    );
  };
  await captureLocalRepositoryAllocationFacts(authority, input());
  expect(batches[0]).toEqual([source, taskRoot]);
});
it('qualifies independent destination absence while original source metadata is inspected', async () => {
  const authority: LocalRepositoryReadAuthority = owner();
  const order: string[] = [];
  authority.captureReadAnchor = async (path) => {
    if (path === task()) order.push('task');
    return fixtureReadAnchor(path);
  };
  authority.executeReadOperation = async (...args) => {
    if (args[0].operation === 'ReadBytes' && args[0].file_path === join(source, '.git', 'config'))
      order.push('config');
    return executeNativeAnchoredReadOperation(...args);
  };
  await captureLocalRepositoryAllocationFacts(authority, input());
  expect(order).toContain('task');
  expect(order).toContain('config');
  expect(order.indexOf('task')).toBeLessThan(order.indexOf('config'));
});
it.each([false, true])(
  'joins bounded independent first-missing allocation probes (failure=%s)',
  async (failure) => {
    const authority = owner();
    const original = authority.captureReadAnchor.getMockImplementation()!;
    let active = 0,
      maximum = 0;
    const finished: string[] = [];
    const probes = new Set([
      task(),
      join(source, '.git', 'worktrees'),
      join(source, '.git', 'logs', 'refs', 'heads', 'mitzo'),
    ]);
    authority.captureReadAnchor.mockImplementation(async (path) => {
      if (!probes.has(path)) return original(path);
      maximum = Math.max(maximum, ++active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (failure && path === join(source, '.git', 'worktrees'))
          throw Error('Fixture missing-probe owner revoked');
        return await original(path);
      } finally {
        active--;
        finished.push(path);
      }
    });
    if (failure)
      await expect(captureLocalRepositoryAllocationFacts(authority, input())).rejects.toThrow();
    else await captureLocalRepositoryAllocationFacts(authority, input());
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(finished).toEqual(expect.arrayContaining([...probes]));
  },
);
it.for(['task', 'admin-parent', 'admin-target', 'ref-lock', 'log-lock'] as const)(
  'refuses physically equivalent allocation absence for %s',
  async (kind, context) => {
    const path =
      kind === 'task'
        ? task()
        : kind === 'admin-parent'
          ? join(source, '.git', 'worktrees')
          : kind === 'admin-target'
            ? join(source, '.git', 'worktrees', `repo-${id}`)
            : join(
                source,
                '.git',
                ...(kind === 'log-lock' ? ['logs'] : []),
                'refs',
                'heads',
                'mitzo',
                `repo-${id}.lock`,
              );
    const foreign = join(dirname(path), path.slice(dirname(path).length + 1).toUpperCase());
    await mkdir(dirname(foreign), { recursive: true });
    if (kind === 'ref-lock' || kind === 'log-lock') await writeFile(foreign, 'FOREIGN BYTES');
    else await mkdir(foreign);
    const before = await lstat(foreign);
    const alias = await lstat(path).catch(() => undefined);
    if (!alias || alias.ino !== before.ino || alias.dev !== before.dev) {
      context.skip();
      return;
    }
    await expect(captureLocalRepositoryAllocationFacts(owner(), input())).rejects.toThrow();
    expect((await lstat(foreign)).ino).toBe(before.ino);
    if (before.isFile()) expect(await readFile(foreign, 'utf8')).toBe('FOREIGN BYTES');
  },
);
it.each([false, true])(
  'captures two independent original anchors concurrently and joins them on refusal (failure=%s)',
  async (failure) => {
    const authority = owner();
    let active = 0,
      maximum = 0;
    const finished: string[] = [];
    authority.captureReadAnchor.mockImplementation(async (path) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, path === taskRoot ? 100 : 50));
        if (failure && path === source) throw Error('Fixture source unavailable');
        return await fixtureReadAnchor(path);
      } finally {
        active--;
        finished.push(path);
      }
    });
    if (failure)
      await expect(captureLocalRepositoryAllocationFacts(authority, input())).rejects.toThrow(
        'Local repository allocation facts unavailable',
      );
    else await captureLocalRepositoryAllocationFacts(authority, input());
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(finished).toEqual(expect.arrayContaining([source, taskRoot]));
  },
);
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

it('binds original existing final publication parents into the facts digest across fresh readers', async () => {
  const administrativeParent = join(source, '.git', 'worktrees');
  await mkdir(administrativeParent);
  const original = await captureLocalRepositoryAllocationFacts(owner(), input());
  const pinned = original.facts.existingDirectories.find(
    (entry) => entry.directory === administrativeParent,
  );
  expect(pinned?.identity.ino).toBe(String((await lstat(administrativeParent)).ino));
  expect(Object.isFrozen(pinned)).toBe(true);
  await rename(administrativeParent, administrativeParent + '-retained');
  await mkdir(administrativeParent);
  const replacement = await captureLocalRepositoryAllocationFacts(owner(), input());
  expect(replacement.factsSha256).not.toBe(original.factsSha256);
}, 30000);

it.each([false, true])(
  'refuses a packed shadow inserted between namespace parsing and publication-witness capture (packed=%s)',
  async (packed) => {
    if (packed) git('pack-refs', '--all');
    const authority = owner(),
      fresh = await captureLocalRepositoryAllocationFacts(authority, input());
    const common = fresh.facts.source.commonAnchor,
      path = join(common.rootPath, 'packed-refs');
    const prior = packed ? await readFile(path, 'utf8') : '';
    await writeFile(
      path,
      prior + git('rev-parse', 'HEAD') + ' refs/heads/' + fresh.facts.featureBranch + '\n',
    );
    expect(fresh.publicationPackedRefs).toEqual(
      packed ? expect.objectContaining({ kind: 'file' }) : { kind: 'absent' },
    );
    if (packed && fresh.publicationPackedRefs.kind === 'file')
      expect(fresh.publicationPackedRefs.sha256).toBe(
        createHash('sha256').update(prior).digest('hex'),
      );
    await expect(fresh.verify()).rejects.toThrow();
    await expect(lstat(task())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(common.rootPath, 'worktrees', 'repo-' + id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);
