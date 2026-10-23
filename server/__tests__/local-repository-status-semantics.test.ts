import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLocalRepository as inspectRepository } from '../local-repository-discovery.js';
import {
  inspectLocalRepositoryGitMetadata,
  readLocalRepositoryStatus,
} from '../local-repository-git-inspection.js';

import {
  fixtureReadAnchor,
  fixtureReadExclusions,
} from './fixtures/local-repository-read-owner.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
const inspectLocalRepository = (request: Parameters<typeof inspectRepository>[0]) =>
  inspectRepository({
    captureReadAnchor: fixtureReadAnchor,
    captureReadExclusions: fixtureReadExclusions,
    ...request,
  });
vi.setConfig({ testTimeout: 30000 });
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const git = (path: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', path, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-status-semantics-')));
  git(root, 'init', '--template=', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Offline Fixture');
  git(root, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(root, 'source.txt'), 'original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const path = root;
  const inspect = () =>
    inspectLocalRepository({ path, accessScope: { kind: 'roots', roots: [path] } });
  return { path, inspect };
}

it.each(['true', 'input'] as const)(
  'keeps a clean CRLF worktree clean with core.autocrlf=%s while preserving its index',
  async (autocrlf) => {
    const f = await fixture();
    git(f.path, 'config', 'core.autocrlf', autocrlf);
    await writeFile(join(f.path, 'source.txt'), 'original\r\n');
    // Establish a clean CRLF stat entry while its normalized index blob remains LF.
    git(f.path, 'add', 'source.txt');
    expect(git(f.path, 'status', '--porcelain=v1')).toBe('');
    const index = await readFile(join(f.path, '.git', 'index'));
    expect((await f.inspect()).dirty).toEqual({ state: 'clean', entries: [] });
    expect(await readFile(join(f.path, '.git', 'index'))).toEqual(index);
    expect(await readFile(join(f.path, 'source.txt'), 'utf8')).toBe('original\r\n');
  },
);

it('preserves core.filemode=false comparison instead of reporting a chmod as an edit', async () => {
  const f = await fixture();
  git(f.path, 'config', 'core.filemode', 'false');
  await chmod(join(f.path, 'source.txt'), 0o755);
  expect(git(f.path, 'status', '--porcelain=v1')).toBe('');
  const index = await readFile(join(f.path, '.git', 'index'));
  expect((await f.inspect()).dirty).toEqual({ state: 'clean', entries: [] });
  expect(await readFile(join(f.path, '.git', 'index'))).toEqual(index);
});

it('still reports real CRLF and executable changes when the comparison settings require them', async () => {
  const f = await fixture();
  git(f.path, 'config', 'core.autocrlf', 'false');
  git(f.path, 'config', 'core.filemode', 'true');
  await writeFile(join(f.path, 'source.txt'), 'original\r\n');
  await chmod(join(f.path, 'source.txt'), 0o755);
  expect((await f.inspect()).dirty).toMatchObject({
    state: 'dirty',
    entries: [{ path: 'source.txt', worktree: 'M' }],
  });
});

it('uses enabled linked-worktree comparison overrides after common configuration', async () => {
  const f = await fixture();
  git(f.path, 'config', 'extensions.worktreeConfig', 'true');
  git(f.path, 'config', 'core.filemode', 'true');
  const linked = join(f.path, 'linked');
  git(f.path, 'worktree', 'add', '-q', '-b', 'linked', linked);
  git(linked, 'config', '--worktree', 'core.filemode', 'false');
  await chmod(join(linked, 'source.txt'), 0o755);
  expect(git(linked, 'status', '--porcelain=v1')).toBe('');
  expect(
    (
      await inspectLocalRepository({
        path: linked,
        accessScope: { kind: 'roots', roots: [f.path] },
      })
    ).dirty,
  ).toEqual({ state: 'clean', entries: [] });
});

it('does not apply disabled worktree configuration', async () => {
  const f = await fixture();
  git(f.path, 'config', 'core.filemode', 'true');
  await writeFile(join(f.path, '.git', 'config.worktree'), '[core]\nfilemode = false\n');
  await chmod(join(f.path, 'source.txt'), 0o755);
  expect((await f.inspect()).dirty).toMatchObject({
    state: 'dirty',
    entries: [{ path: 'source.txt', worktree: 'M' }],
  });
});

it('honors bounded local info/exclude rules without leaking ignored filenames', async () => {
  const f = await fixture();
  await mkdir(join(f.path, '.git', 'info'), { recursive: true });
  const exclude = join(f.path, '.git', 'info', 'exclude');
  await writeFile(exclude, 'private-local.txt\n');
  await writeFile(join(f.path, 'private-local.txt'), 'Offline private fixture\n');
  await writeFile(join(f.path, 'visible.txt'), 'Public fixture\n');
  const before = await readFile(exclude);
  const index = await readFile(join(f.path, '.git', 'index'));
  expect(git(f.path, 'status', '--porcelain=v1')).toBe('?? visible.txt');
  const result = await f.inspect();
  expect(result.dirty).toEqual({
    state: 'dirty',
    entries: [{ path: 'visible.txt', index: '?', worktree: '?' }],
  });
  expect(JSON.stringify(result.dirty)).not.toContain('private-local.txt');
  expect(await readFile(exclude)).toEqual(before);
  expect(await readFile(join(f.path, '.git', 'index'))).toEqual(index);
});

it('reads linked-worktree exclude rules from common Git storage', async () => {
  const f = await fixture();
  await mkdir(join(f.path, '.git', 'info'), { recursive: true });
  await writeFile(join(f.path, '.git', 'info', 'exclude'), 'private-local.txt\n');
  const linked = join(f.path, 'linked');
  git(f.path, 'worktree', 'add', '-q', '-b', 'linked', linked);
  await writeFile(join(linked, 'private-local.txt'), 'Offline private fixture\n');
  expect(
    (
      await inspectLocalRepository({
        path: linked,
        accessScope: { kind: 'roots', roots: [f.path] },
      })
    ).dirty,
  ).toEqual({ state: 'clean', entries: [] });
});

it('requires explicit read authorization before consuming exclude bytes', async () => {
  const f = await fixture();
  await mkdir(join(f.path, '.git', 'info'), { recursive: true });
  const exclude = join(f.path, '.git', 'info', 'exclude');
  await writeFile(exclude, 'private-local.txt\n');
  const assertReadable = vi.fn(async (path: string) => {
    if (path === exclude) throw Error('Denied exclude');
  });
  const access = new LocalRepositoryReadAccess({
    deniedRoots: Object.freeze([]),
    assertReadable,
    captureReadAnchor: fixtureReadAnchor,
    deadline: Date.now() + 30000,
  });
  await access.pinRoot(f.path);
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: f.path,
    assertReadable: async () => {},
    readAccess: access,
    timeoutMs: 30000,
  });
  await expect(
    readLocalRepositoryStatus(metadata, { timeoutMs: 10000, readAccess: access }),
  ).rejects.toMatchObject({ kind: 'access', reason: 'read-access-required' });
  expect(assertReadable).toHaveBeenCalledWith(exclude);
});

it('reports unknown status for oversized local exclusion rules rather than leaking ignored entries', async () => {
  const f = await fixture();
  await mkdir(join(f.path, '.git', 'info'), { recursive: true });
  await writeFile(
    join(f.path, '.git', 'info', 'exclude'),
    'private-local.txt\n' + '#'.repeat(65536),
  );
  await writeFile(join(f.path, 'private-local.txt'), 'Offline private fixture\n');
  const result = await f.inspect();
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([{ path: f.path, reason: 'dirty-state-unavailable' }]),
  );
});

it('retains repository facts and reports unknown for unsupported comparison values', async () => {
  const f = await fixture();
  git(f.path, 'config', 'core.filemode', '2');
  expect(git(f.path, 'config', '--type=bool', '--get', 'core.filemode')).toBe('true');
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: f.path,
    assertReadable: async () => {},
  });
  expect(metadata.comparisonConfig).toMatchObject({ unsupported: true });
  expect(Object.isFrozen(metadata.comparisonConfig)).toBe(true);
  const inspected = await f.inspect();
  expect(inspected.path).toBe(f.path);
  expect(inspected.head).toBeTruthy();
  expect(inspected.dirty).toEqual({ state: 'unknown', entries: [] });
});

it('keeps custom core.excludesFile names private by reporting unknown without reading that path', async () => {
  const f = await fixture();
  const rules = join(f.path, '.git', 'local-excludes');
  await writeFile(rules, 'private-local.txt\n');
  git(f.path, 'config', 'core.excludesFile', rules);
  await writeFile(join(f.path, 'private-local.txt'), 'Offline private fixture\n');
  expect(git(f.path, 'status', '--porcelain=v1')).toBe('');
  const result = await f.inspect();
  expect(result.head).toBeTruthy();
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
});

it('reports unknown for unsupported regular-file representations of index symlinks', async () => {
  const f = await fixture();
  git(f.path, 'config', 'core.symlinks', 'false');
  const oid = git(f.path, 'hash-object', '-w', 'source.txt');
  git(f.path, 'update-index', '--add', '--cacheinfo', `120000,${oid},link.txt`);
  await writeFile(join(f.path, 'link.txt'), 'original\n');
  git(f.path, 'commit', '-qm', 'fixture symbolic entry');
  expect(git(f.path, 'status', '--porcelain=v1')).toBe('');
  const result = await f.inspect();
  expect(result.head).toBeTruthy();
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
});
