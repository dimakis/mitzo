import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLocalRepository as inspectRepository } from '../local-repository-discovery.js';
import {
  inspectLocalRepositoryGitMetadata,
  readIsolatedLocalRepositoryStatus,
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
  // Controlled private-comparison evidence is separate from product source-
  // effective status. This fixture never qualifies omitted real host settings.
  const compare = async (selected = path) => {
    const access = new LocalRepositoryReadAccess({
      deniedRoots: Object.freeze([]),
      assertReadable: async (target) => {
        if (target !== path && !target.startsWith(path + '/')) throw Error('Outside fixture');
      },
      captureReadAnchor: fixtureReadAnchor,
      deadline: Date.now() + 30000,
    });
    await access.pinRoot(selected);
    const metadata = await inspectLocalRepositoryGitMetadata({
      path: selected,
      assertReadable: async () => {},
      readAccess: access,
      timeoutMs: 30000,
    });
    return readIsolatedLocalRepositoryStatus(metadata, { timeoutMs: 30000, readAccess: access });
  };
  return { path, inspect, compare };
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
    expect(await f.compare()).toBe('');
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
  expect(await f.compare()).toBe('');
  expect(await readFile(join(f.path, '.git', 'index'))).toEqual(index);
});

it('still reports real CRLF and executable changes when the comparison settings require them', async () => {
  const f = await fixture();
  git(f.path, 'config', 'core.autocrlf', 'false');
  git(f.path, 'config', 'core.filemode', 'true');
  await writeFile(join(f.path, 'source.txt'), 'original\r\n');
  await chmod(join(f.path, 'source.txt'), 0o755);
  expect(await f.compare()).toContain(' M source.txt\0');
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
  expect(await f.compare(linked)).toBe('');
});

it('does not apply disabled worktree configuration', async () => {
  const f = await fixture();
  git(f.path, 'config', 'core.filemode', 'true');
  await writeFile(join(f.path, '.git', 'config.worktree'), '[core]\nfilemode = false\n');
  await chmod(join(f.path, 'source.txt'), 0o755);
  expect(await f.compare()).toContain(' M source.txt\0');
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
  const comparison = await f.compare();
  expect(comparison).toBe('?? visible.txt\0');
  expect(comparison).not.toContain('private-local.txt');
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
  expect(await f.compare(linked)).toBe('');
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
    readIsolatedLocalRepositoryStatus(metadata, { timeoutMs: 10000, readAccess: access }),
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
  await expect(f.compare()).rejects.toMatchObject({ kind: 'limit', reason: 'snapshot-bytes' });
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
  await expect(f.compare()).rejects.toMatchObject({
    reason: 'comparison-configuration-unsupported',
  });
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

it('never certifies non-idempotent clean-filter bytes as clean without executing source filters', async () => {
  const f = await fixture();
  git(f.path, 'config', 'filter.shift.clean', 'tr ab bc');
  await writeFile(join(f.path, '.gitattributes'), 'source.txt filter=shift\n');
  await writeFile(join(f.path, 'source.txt'), 'a\n');
  git(f.path, 'add', '.gitattributes', 'source.txt');
  git(f.path, 'commit', '-qm', 'fixture filtered blob');
  expect(git(f.path, 'show', 'HEAD:source.txt')).toBe('b');
  await writeFile(join(f.path, 'source.txt'), 'b\n');
  expect(git(f.path, 'status', '--porcelain=v1')).toBe('M source.txt');
  const index = await readFile(join(f.path, '.git', 'index'));
  await expect(f.compare()).rejects.toMatchObject({
    reason: 'comparison-configuration-unsupported',
  });
  const result = await f.inspect();
  expect(result.head).toBeTruthy();
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
  expect(await readFile(join(f.path, '.git', 'index'))).toEqual(index);
  expect(await readFile(join(f.path, 'source.txt'), 'utf8')).toBe('b\n');
});

it.each(['private-info', 'external-config'] as const)(
  'reports unknown for deliberately omitted %s attribute semantics',
  async (location) => {
    const f = await fixture();
    const attributes = join(
      f.path,
      '.git',
      location === 'private-info' ? 'info/attributes' : 'local-attributes',
    );
    await mkdir(join(f.path, '.git', 'info'), { recursive: true });
    await writeFile(attributes, 'source.txt text eol=lf\n');
    if (location === 'external-config') git(f.path, 'config', 'core.attributesFile', attributes);
    await writeFile(join(f.path, 'source.txt'), 'original\r\n');
    git(f.path, 'add', 'source.txt');
    expect(git(f.path, 'status', '--porcelain=v1')).toBe('');
    const metadata = await inspectLocalRepositoryGitMetadata({
      path: f.path,
      assertReadable: async () => {},
    });
    expect(metadata.comparisonConfig).toMatchObject({ unsupported: true });
    expect((await f.inspect()).dirty).toEqual({ state: 'unknown', entries: [] });
  },
);

it.each(['root', 'nested'] as const)(
  'refuses unqualified %s worktree attributes with a synthetic global-only clean filter',
  async (location) => {
    const f = await fixture();
    const global = join(f.path, '.git', 'fixture-global.config');
    await writeFile(global, '[filter "shift"]\nclean = tr ab bc\n');
    const controlledGit = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', f.path, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: '/nonexistent',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: global,
          },
        },
      ).trim();
    const directory = location === 'root' ? f.path : join(f.path, 'nested');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.gitattributes'), 'filtered.txt filter=shift\n');
    await writeFile(join(directory, 'filtered.txt'), 'a\n');
    controlledGit('add', '.');
    controlledGit('commit', '-qm', 'fixture global filter');
    const relative = location === 'root' ? 'filtered.txt' : 'nested/filtered.txt';
    expect(controlledGit('show', `HEAD:${relative}`)).toBe('b');
    expect(git(f.path, 'config', '--local', '--list')).not.toContain('filter.shift');
    await writeFile(join(directory, 'filtered.txt'), 'b\n');
    expect(controlledGit('status', '--porcelain=v1')).toBe(`M ${relative}`);
    await expect(f.compare()).rejects.toMatchObject({
      reason: 'comparison-attributes-unsupported',
    });
    const result = await f.inspect();
    expect(result.head).toBeTruthy();
    expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
  },
);

it('keeps source-effective status unknown without qualified omitted global attributes even when no worktree attributes exist', async () => {
  const f = await fixture();
  const attributes = join(f.path, '.git', 'fixture-external-attributes');
  const global = join(f.path, '.git', 'fixture-global.config');
  await writeFile(attributes, 'source.txt filter=shift\n');
  await writeFile(
    global,
    `[core]\nattributesFile = ${attributes}\n[filter "shift"]\nclean = tr ab bc\n`,
  );
  const controlledGit = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', f.path, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: '/nonexistent',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: global,
        },
      },
    ).trim();
  await writeFile(join(f.path, 'source.txt'), 'a\n');
  controlledGit('add', 'source.txt');
  controlledGit('commit', '-qm', 'fixture omitted global attributes');
  expect(controlledGit('show', 'HEAD:source.txt')).toBe('b');
  expect(controlledGit('ls-files')).not.toContain('.gitattributes');
  expect(git(f.path, 'config', '--local', '--list')).not.toContain('filter.shift');
  await writeFile(join(f.path, 'source.txt'), 'b\n');
  expect(controlledGit('status', '--porcelain=v1')).toBe('M source.txt');
  // The private copy really is equal while effective source Git is dirty.
  expect(await f.compare()).toBe('');
  expect((await f.inspect()).dirty).toEqual({ state: 'unknown', entries: [] });
});

it('does not promote an ordinary private comparison to source-effective clean', async () => {
  const f = await fixture();
  expect(git(f.path, 'status', '--porcelain=v1')).toBe('');
  expect(await f.compare()).toBe('');
  const result = await f.inspect();
  expect(result.head).toBeTruthy();
  expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
});
