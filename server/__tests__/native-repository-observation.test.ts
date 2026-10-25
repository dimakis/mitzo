import { afterEach, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { NativeFileHelperTransport } from '../native-file-operation.js';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureRepositoryObservation,
  RepositoryObservationMissingError,
  RepositoryObservationReadAccessError,
  verifyRepositoryObservation,
} from '../native-repository-observation.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('captures one bounded repository observation and detects changed bytes before return', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-observation-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'AGENTS.md'), 'Original instructions');
  const request = {
    version: 'repository-read-v1' as const,
    mode: 'orientation' as const,
    sourcePath: root,
    readableRoots: ['/'],
    deniedRoots: [],
    excludedNames: [],
  };
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  // Physical helper integration uses its actual fixed Python program without inference.
  const held = await captureRepositoryObservation(
    request,
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((file) => file.path === join(root, 'AGENTS.md'))).toBe(true);
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
  await writeFile(join(root, 'AGENTS.md'), 'Changed instructions');
  await expect(
    verifyRepositoryObservation(
      held.plan,
      held.digest,
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.toThrow();
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('Changed instructions');
});

it('restricts the physical batch to the projected roots before reading Git indirection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-scope-')));
  roots.push(root);
  const source = join(root, 'source'),
    outside = join(root, 'outside');
  await mkdir(source);
  await mkdir(outside);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', source]);
  await writeFile(join(root, 'AGENTS.md'), 'OUTSIDE SCOPE');
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const plan = {
    version: 'repository-read-v1',
    mode: 'orientation',
    sourcePath: source,
    readableRoots: [source],
    deniedRoots: [],
    excludedNames: [],
  };
  const held = await captureRepositoryObservation(
    plan,
    new AbortController().signal,
    10000,
    transport,
  );
  expect(
    held.data.entries.every((item) => item.path === source || item.path.startsWith(source + '/')),
  ).toBe(true);
  expect(held.data.files.some((item) => item.path === join(root, 'AGENTS.md'))).toBe(false);
  await rm(join(source, '.git'), { recursive: true });
  await writeFile(join(source, '.git'), 'gitdir: ' + outside + '\n');
  await expect(
    captureRepositoryObservation(plan, new AbortController().signal, 10000, transport),
  ).rejects.toThrow();
});

it('captures an enclosing repository from a nested cwd and tolerates a missing optional objects/info directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-nested-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  const nested = join(root, 'src', 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'AGENTS.md'), 'nested instructions');
  await rm(join(root, '.git', 'objects', 'info'), { recursive: true, force: true });
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'orientation',
      sourcePath: nested,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((item) => item.path === join(root, '.git', 'HEAD'))).toBe(true);
  expect(held.data.files.some((item) => item.path === join(nested, 'AGENTS.md'))).toBe(true);
  expect(held.data.absent).toContain(join(root, '.git', 'objects', 'info'));
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('captures the exact published task metadata in one adoption observation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-adoption-')));
  roots.push(root);
  const source = join(root, 'source'),
    tasks = join(root, 'tasks');
  await mkdir(source);
  await mkdir(tasks);
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      ['-C', source, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
        stdio: 'ignore',
      },
    );
  git('init', '--template=', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'tracked.txt'), 'tracked');
  git('add', '.');
  git('commit', '-qm', 'base');
  const workspaceId = '12345678-1234-4234-8234-123456789abc',
    task = join(tasks, 'repo-' + workspaceId);
  git('worktree', 'add', '-q', '-b', 'mitzo/repo-' + workspaceId, task);
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'adoption',
      sourcePath: source,
      taskRoot: tasks,
      workspaceId,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  for (const path of [
    join(task, '.git'),
    join(source, '.git', 'worktrees', 'repo-' + workspaceId, 'index'),
    join(source, '.git', 'refs', 'heads', 'mitzo', 'repo-' + workspaceId),
  ])
    expect(
      held.data.files.some((file) => file.path === path),
      path,
    ).toBe(true);
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('keeps HEAD inspection available when an optional worktree registry cannot be read safely', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-optional-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  await symlink('/unavailable-offline-fixture', join(root, '.git', 'worktrees'));
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'orientation',
      sourcePath: root,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((item) => item.path === join(root, '.git', 'HEAD'))).toBe(true);
  expect(held.data.directories.some((item) => item.path === join(root, '.git', 'worktrees'))).toBe(
    false,
  );
  expect(held.data.absent).not.toContain(join(root, '.git', 'worktrees'));
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('rolls back merged sibling reference names after a later optional worktree read fails', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-rollback-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  const common = join(root, '.git'),
    sibling = join(common, 'worktrees', 'sibling');
  await mkdir(sibling, { recursive: true });
  await writeFile(join(common, 'refs', 'heads', 'other'), 'a'.repeat(40) + '\n');
  await writeFile(join(sibling, 'HEAD'), 'ref: refs/heads/other\n');
  await symlink('/unavailable-offline-fixture', join(sibling, 'gitdir'));
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'orientation',
      sourcePath: root,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((item) => item.path === join(common, 'HEAD'))).toBe(true);
  expect(held.data.files.some((item) => item.path === join(common, 'refs', 'heads', 'other'))).toBe(
    false,
  );
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('preserves typed source absence without exposing denied paths or storage failures as missing', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-missing-')));
  roots.push(root);
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const source = join(root, 'missing');
  const plan = {
    version: 'repository-read-v1',
    mode: 'discovery',
    sourcePath: source,
    readableRoots: [root],
    deniedRoots: [],
    excludedNames: [],
  };
  await expect(
    captureRepositoryObservation(plan, new AbortController().signal, 10000, transport),
  ).rejects.toBeInstanceOf(RepositoryObservationMissingError);
  await expect(
    captureRepositoryObservation(
      { ...plan, deniedRoots: [source] },
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.toBeInstanceOf(RepositoryObservationReadAccessError);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  await rm(join(root, '.git', 'objects'), { recursive: true });
  await symlink('/unavailable-offline-fixture', join(root, '.git', 'objects'));
  await expect(
    captureRepositoryObservation(
      { ...plan, sourcePath: root },
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.not.toBeInstanceOf(RepositoryObservationMissingError);
});
