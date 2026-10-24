import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NativeAnchoredReadRequest } from '../native-file-operation.js';
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

// Selected instruction controls use synthetic transports over disposable data
// with virtual/empty host ancestors. Unselected legacy cases retain their
// original native-helper defaults and are not run in this focused correction.
vi.setConfig({ testTimeout: 30000 });

let root: string;
async function syntheticRead(request: NativeAnchoredReadRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  if (request.file_path !== root && !request.file_path.startsWith(root + '/')) {
    if (request.operation !== 'ListDirectory') throw Error('Unexpected ambient fixture read');
    return {
      content: JSON.stringify({
        identity: request.identity,
        entries: [],
        truncated: false,
        incomplete: false,
      }),
      is_error: false,
    };
  }
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
      throw Error('Synthetic identity changed');
  }
  if (request.operation === 'ReadBytes' || request.operation === 'ReadLink') {
    const before = await lstat(request.file_path, { bigint: true });
    if (
      before.nlink !== 1n ||
      (request.operation === 'ReadBytes' ? !before.isFile() : !before.isSymbolicLink()) ||
      (request.expectedState &&
        (Number(before.size) !== request.expectedState.size ||
          String(before.mtimeNs) !== request.expectedState.mtimeNs ||
          String(before.ctimeNs) !== request.expectedState.ctimeNs))
    )
      throw Error('Synthetic byte/link state changed');
    const bytes =
      request.operation === 'ReadLink'
        ? Buffer.from(await readlink(request.file_path))
        : await readFile(request.file_path);
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
  let incomplete = false;
  for (const name of await readdir(request.file_path)) {
    const path = join(request.file_path, name);
    if (request.deniedRoots.some((denied) => path === denied || path.startsWith(denied + '/'))) {
      incomplete = true;
      continue;
    }
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
function ancestorChurn() {
  let observations = 0;
  return {
    count: () => observations,
    read: async (request: NativeAnchoredReadRequest, signal: AbortSignal) => {
      const result = await syntheticRead(request, signal);
      if (request.operation === 'ListDirectory' && request.file_path === '/') {
        observations++;
        if (observations > 1) {
          const value = JSON.parse(result.content);
          value.entries.push({
            name: 'unrelated-fixture',
            identity: { dev: '1', ino: '2' },
            kind: 'file',
            size: 0,
            mode: 32768,
            nlink: 1,
            mtimeNs: '0',
            ctimeNs: '0',
          });
          return { content: JSON.stringify(value), is_error: false };
        }
      }
      return result;
    },
  };
}
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
    const churn = ancestorChurn();
    const requested: string[] = [];
    const result = await inspectLocalRepository({
      path: selected,
      accessScope: scope([denied]),
      // This unit checks repository instruction aliases, not ambient host
      // ancestry. Shared CI ancestor churn has its own strict-refusal control.
      limits: { maxInstructionDirectories: 1 },
      executeReadOperation: async (request, signal) => {
        requested.push(request.file_path);
        return churn.read(request, signal);
      },
    });
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
    expect(requested.every((path) => path !== denied && !path.startsWith(denied + '/'))).toBe(true);
    expect(churn.count()).toBe(0);
    expect(requested.filter((path) => path === selected).length).toBeGreaterThanOrEqual(2);
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

it('refuses changed unrelated ancestor listings during full host-wide verification', async () => {
  const selected = await repository(join(root, 'target'));
  const churn = ancestorChurn();
  await expect(
    inspectLocalRepository({
      path: selected,
      accessScope: { kind: 'host-wide' },
      executeReadOperation: churn.read,
    }),
  ).rejects.toMatchObject({ kind: 'unsafe', reason: 'anchored-read-unavailable' });
  expect(churn.count()).toBe(2);
});
