import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import type { NativeAnchoredReadRequest } from '../native-file-operation.js';
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
// Explicit synthetic transport for the selected large-directory control only.
// Other legacy cases retain their native-helper defaults and are not run here.
async function syntheticRead(request: NativeAnchoredReadRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  for (const [path, expected] of [
    [request.rootAnchor.rootPath, request.rootAnchor.identity],
    [request.file_path, request.identity],
    [
      request.file_path === request.rootAnchor.rootPath
        ? request.file_path
        : dirname(request.file_path),
      request.parentIdentity,
    ],
  ] as const) {
    const info = await lstat(path, { bigint: true });
    if (String(info.dev) !== expected.dev || String(info.ino) !== expected.ino)
      throw Error('Synthetic read identity changed');
  }
  if (request.operation === 'ReadBytes') {
    const info = await lstat(request.file_path, { bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      (request.expectedState &&
        (Number(info.size) !== request.expectedState.size ||
          String(info.mtimeNs) !== request.expectedState.mtimeNs ||
          String(info.ctimeNs) !== request.expectedState.ctimeNs))
    )
      throw Error('Synthetic byte state changed');
    const bytes = await readFile(request.file_path);
    if (bytes.length > request.limit && !request.prefix)
      return { content: 'Anchored read limit exceeded', is_error: true };
    return {
      content: bytes.subarray(0, request.limit).toString('base64'),
      is_error: false,
      ...(request.prefix ? { truncated: bytes.length > request.limit } : {}),
    };
  }
  if (request.operation !== 'ListDirectory') throw Error('Unexpected synthetic operation');
  const entries = [];
  let names = 0,
    incomplete = false;
  for (const name of await readdir(request.file_path)) {
    const path = join(request.file_path, name);
    if (request.deniedRoots.some((denied) => path === denied || path.startsWith(denied + '/'))) {
      incomplete = true;
      continue;
    }
    names += Buffer.byteLength(name);
    if (
      entries.length >= 10000 ||
      names > 1024 * 1024 ||
      (entries.length + 1) * 512 + names * 6 > 6 * 1024 * 1024
    )
      return { content: 'Anchored read limit exceeded', is_error: true };
    const info = await lstat(path, { bigint: true });
    entries.push({
      name,
      identity: { dev: String(info.dev), ino: String(info.ino) },
      kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported',
      size: Number(info.size),
      mode: Number(info.mode),
      nlink: Number(info.nlink),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
    });
  }
  signal.throwIfAborted();
  return {
    content: JSON.stringify({ identity: request.identity, entries, truncated: false, incomplete }),
    is_error: false,
  };
}
const authority = (executeReadOperation?: typeof syntheticRead) => ({
  deniedRoots: [],
  deadline: Date.now() + 30000,
  assertReadable: async () => {},
  captureReadAnchor: fixtureReadAnchor,
  ...(executeReadOperation ? { executeReadOperation } : {}),
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
async function fixture(executeReadOperation?: typeof syntheticRead) {
  const original = await captureLocalRepositoryAllocationFacts(authority(executeReadOperation), {
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
    access: (signal?: AbortSignal) =>
      new LocalRepositoryReadAccess({ ...authority(executeReadOperation), signal }),
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

it('retains ordinary task directory limits and reads known metadata in bounded joined pairs', async () => {
  const f = await fixture();
  const access = f.access();
  const preload = vi.spyOn(access, 'preloadDirectories');
  const original = access.read.bind(access);
  let active = 0,
    peak = 0;
  vi.spyOn(access, 'read').mockImplementation(async (path, limit) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return await original(path, limit);
    } finally {
      active--;
    }
  });
  const observed = await captureQualifiedLocalRepositoryTask(access, f.facts, f.publication);
  expect(observed.directory).toBe(task);
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(
    preload.mock.calls.every(([paths]) => !paths.includes(join(source, '.git', 'worktrees'))),
  ).toBe(true);
});

it.each(['failure', 'abort'] as const)(
  'joins a %s task metadata pair without starting later metadata or returning custody',
  async (kind) => {
    const f = await fixture();
    const controller = new AbortController();
    const access = f.access(controller.signal);
    const original = access.read.bind(access);
    let started = 0,
      settled = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(access, 'read').mockImplementation(async (path, limit) => {
      if (!path.startsWith(f.admin + '/')) return original(path, limit);
      if (started++ === 0) {
        if (kind === 'abort') controller.abort(Error('synthetic task abort'));
        throw Error('synthetic first metadata refusal');
      }
      await held;
      throw Error('synthetic joined metadata refusal');
    });
    const pending = captureQualifiedLocalRepositoryTask(access, f.facts, f.publication).finally(
      () => {
        settled = true;
      },
    );
    const outcome = expect(pending).rejects.toThrow('Qualified repository task unavailable');
    try {
      for (let i = 0; i < 2000 && started < 2 && !settled; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toBe(2);
      expect(settled).toBe(false);
    } finally {
      release();
      await outcome;
    }
    expect(started).toBe(2);
  },
);

it('preserves ordinary listing coverage for a large shared worktrees directory', async () => {
  const f = await fixture(syntheticRead);
  const worktrees = join(source, '.git', 'worktrees');
  for (let index = 0; index < 9900; index++)
    // Keep 20 UTF-8 bytes per name; increase JSON escaping while preserving the
    // helper's conservative entry/name envelope reservation.
    await mkdir(join(worktrees, `${String(index).padStart(4, '0')}${'"'.repeat(16)}`));
  let bytes = 0,
    entries = 0,
    names = 0;
  const access = new LocalRepositoryReadAccess({
    ...authority(syntheticRead),
    executeReadOperation: async (...args) => {
      const result = await syntheticRead(args[0], args[1]);
      if (args[0].operation === 'ListDirectory' && args[0].file_path === worktrees) {
        const listing = JSON.parse(result.content);
        entries = listing.entries.length;
        names = listing.entries.reduce(
          (total: number, entry: { name: string }) => total + Buffer.byteLength(entry.name),
          0,
        );
        // Fixed valid fixture wire encoding; physical metadata stays unchanged.
        // Its minimum below does not depend on host inode/timestamp digit widths.
        result.content = JSON.stringify(listing, null, 1);
        bytes = Math.max(bytes, Buffer.byteLength(result.content));
      }
      return result;
    },
  });
  await expect(
    captureQualifiedLocalRepositoryTask(access, f.facts, f.publication),
  ).resolves.toMatchObject({ directory: task });
  expect(bytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(bytes).toBeLessThan(6 * 1024 * 1024);
  expect(entries).toBe(9901);
  expect(names).toBeLessThanOrEqual(1024 * 1024);
  expect(entries * 512 + names * 6).toBeLessThanOrEqual(6 * 1024 * 1024);
  // Conservative wire-size lower bound ONLY, never supplied as observations.
  // Even one-digit identities/times/sizes and no extra admin entry must exceed2MiB.
  const minimum = JSON.stringify(
    {
      identity: { dev: '0', ino: '0' },
      entries: Array.from({ length: 9900 }, (_, index) => ({
        name: `${String(index).padStart(4, '0')}${'"'.repeat(16)}`,
        identity: { dev: '0', ino: '0' },
        kind: 'directory',
        size: 0,
        mode: 0,
        nlink: 0,
        mtimeNs: '0',
        ctimeNs: '0',
      })),
      truncated: false,
      incomplete: false,
    },
    null,
    1,
  );
  expect(Buffer.byteLength(minimum)).toBeGreaterThan(2 * 1024 * 1024);
}, 60000);
