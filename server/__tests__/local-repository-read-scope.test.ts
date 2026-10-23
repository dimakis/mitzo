import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverLocalRepository as discoverRepository,
  inspectLocalRepository as inspectRepository,
  type LocalRepositoryReadScope,
} from '../local-repository-discovery.js';

import {
  fixtureReadAnchor,
  fixtureReadExclusions,
} from './fixtures/local-repository-read-owner.js';
const discoverLocalRepository = (request: Parameters<typeof discoverRepository>[0]) =>
  discoverRepository({
    captureReadAnchor: fixtureReadAnchor,
    captureReadExclusions: fixtureReadExclusions,
    ...request,
  });
const inspectLocalRepository = (request: Parameters<typeof inspectRepository>[0]) =>
  inspectRepository({
    captureReadAnchor: fixtureReadAnchor,
    captureReadExclusions: fixtureReadExclusions,
    ...request,
  });

// Descriptor-relative fixture I/O launches the isolated existing Python helper.
vi.setConfig({ testTimeout: 30000 });

let root: string;
const statusReads = vi.hoisted(() => vi.fn());
vi.mock('../local-repository-git-inspection.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../local-repository-git-inspection.js')>();
  return {
    ...original,
    readLocalRepositoryStatus: (...args: Parameters<typeof original.readLocalRepositoryStatus>) => {
      statusReads();
      return original.readLocalRepositoryStatus(...args);
    },
  };
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
async function repository(path: string) {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.name', 'Offline Fixture');
  git(path, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(path, 'source.txt'), 'source\n');
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'fixture');
  return path;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-read-scope-')));
});
afterEach(async () => {
  statusReads.mockClear();
  await rm(root, { recursive: true, force: true });
});

describe.each(['roots', 'host-wide'] as const)('effective denied roots with %s access', (kind) => {
  const scope = (deniedRoots: readonly string[]): LocalRepositoryReadScope =>
    kind === 'roots' ? { kind, roots: [root], deniedRoots } : { kind, deniedRoots };

  it('omits denied subtrees from bounded scanning without treating them as repository candidates', async () => {
    const allowed = await repository(join(root, 'allowed', 'target'));
    const denied = join(root, 'denied');
    await repository(join(denied, 'target'));
    const result = await discoverLocalRepository({
      query: 'target',
      discoveryRoots: [root],
      accessScope: scope([denied]),
    });
    expect(result).toMatchObject({
      state: 'selected',
      candidates: [{ path: allowed }],
      truncated: false,
      restricted: true,
    });
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(denied);
  });

  it('denies explicit private paths and refuses directory aliases without learning their target authority', async () => {
    const denied = await repository(join(root, 'denied', 'target'));
    const alias = join(root, 'alias');
    await symlink(denied, alias);
    expect(
      await discoverLocalRepository({
        explicitPath: denied,
        accessScope: scope([join(root, 'denied')]),
      }),
    ).toMatchObject({ state: 'access-required', candidates: [], needed: ['read-access'] });
    const result = await discoverLocalRepository({
      explicitPath: alias,
      accessScope: scope([join(root, 'denied')]),
    });
    expect(result).toMatchObject({
      state: 'ambiguous',
      candidates: [],
      needed: [],
      diagnostics: [{ reason: 'inspection-unavailable' }],
    });
    expect(JSON.stringify(result)).not.toContain(denied);
  });

  it('denies a lexical alias even if it resolves to an otherwise readable repository', async () => {
    const selected = await repository(join(root, 'allowed', 'target'));
    const alias = join(root, 'denied-alias');
    await symlink(selected, alias);
    expect(
      await discoverLocalRepository({ explicitPath: alias, accessScope: scope([alias, selected]) }),
    ).toMatchObject({
      state: 'access-required',
      candidates: [],
      needed: ['read-access'],
    });
    // Denial aliases remain excluded through their resolved storage name too.
    expect(
      await discoverLocalRepository({
        explicitPath: selected,
        accessScope: scope([alias, selected]),
      }),
    ).toMatchObject({
      state: 'access-required',
      candidates: [],
    });
  });

  it('refuses denied external Git metadata before parsing its invalid configuration', async () => {
    const selected = await repository(join(root, 'target'));
    const storage = join(root, 'denied-storage');
    await rename(join(selected, '.git'), storage);
    await writeFile(join(selected, '.git'), `gitdir: ${storage}\n`);
    await writeFile(join(storage, 'config'), 'invalid Git configuration\n');
    await expect(
      inspectLocalRepository({ path: selected, accessScope: scope([storage]) }),
    ).rejects.toMatchObject({
      kind: 'access',
      reason: 'read-access-required',
    });
  });

  it('does not read instructions through a symlink into a denied subtree', async () => {
    const selected = await repository(join(root, 'target'));
    const denied = join(root, 'denied-instructions');
    await mkdir(denied);
    await writeFile(join(denied, 'rules.md'), 'DENIED INSTRUCTION CONTENT\n');
    await symlink(join(denied, 'rules.md'), join(selected, 'AGENTS.md'));
    await writeFile(join(selected, 'CLAUDE.md'), 'Readable repository guidance\n');
    const result = await inspectLocalRepository({ path: selected, accessScope: scope([denied]) });
    expect(result.instructions.files.map((file) => file.content).join('\n')).not.toContain(
      'DENIED INSTRUCTION CONTENT',
    );
    expect(
      result.instructions.files.some((file) => file.path === join(selected, 'CLAUDE.md')),
    ).toBe(true);
    expect(result.instructions.omitted).toContainEqual({
      path: join(selected, 'AGENTS.md'),
      reason: 'symlink',
    });
  });

  it('reports unknown dirty state instead of scanning denied repository content', async () => {
    const selected = await repository(join(root, 'target'));
    const denied = join(selected, 'private');
    await mkdir(denied);
    await writeFile(join(denied, 'secret.txt'), 'Excluded content\n');
    const result = await inspectLocalRepository({ path: selected, accessScope: scope([denied]) });
    expect(result.dirty).toEqual({ state: 'unknown', entries: [] });
    expect(result.diagnostics).toContainEqual({
      path: selected,
      reason: 'dirty-state-unavailable',
    });
    expect(statusReads).not.toHaveBeenCalled();
  });
});
