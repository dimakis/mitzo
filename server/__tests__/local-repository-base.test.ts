import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile, mkdir, truncate, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireRemoteRepositoryBase,
  localRepositoryRemote,
  RepositoryBaseIntentSchema,
  type LocalRepositoryRemoteGit,
  readLocalRepositoryBaseReference,
  localRepositoryPreparationId,
  RepositorySourceIntentSchema,
  initializeLocalRepositorySource,
} from '../local-repository-base.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('identifies an allocation by task, repository and base rather than a transient tool call', () => {
  const task = {
    conversationId: 'conversation',
    workspaceId: 'task',
    path: '/fixture/source',
    base: { kind: 'default' as const },
  };
  expect(localRepositoryPreparationId(task)).toBe(localRepositoryPreparationId({ ...task }));
  expect(localRepositoryPreparationId(task)).not.toBe(
    localRepositoryPreparationId({ ...task, workspaceId: 'new-task' }),
  );
  expect(localRepositoryPreparationId(task)).not.toBe(
    localRepositoryPreparationId({ ...task, base: { kind: 'ref', ref: 'HEAD' } }),
  );
});

it('normalizes existing/clone/new source intent without making host-specific repository assumptions', () => {
  expect(
    RepositorySourceIntentSchema.parse({ kind: 'existing', path: '/fixture/any-repo' }),
  ).toEqual({ kind: 'existing', path: '/fixture/any-repo' });
  expect(
    RepositorySourceIntentSchema.parse({
      kind: 'clone',
      url: 'git@example.invalid:team/any-repo.git',
    }),
  ).toEqual({ kind: 'clone', url: 'ssh://git@example.invalid/team/any-repo.git' });
  expect(RepositorySourceIntentSchema.parse({ kind: 'new', name: 'new-project' })).toEqual({
    kind: 'new',
    name: 'new-project',
  });
  expect(() => RepositorySourceIntentSchema.parse({ kind: 'new', name: '../outside' })).toThrow();
});

it('initializes a new independent local Git source without remote hosting or inherited Git configuration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-new-')));
  roots.push(root);
  const directory = join(root, 'new');
  const base = await initializeLocalRepositorySource(
    directory,
    'new-project',
    new AbortController().signal,
  );
  expect(base).toMatchObject({ branch: 'main', origin: 'local' });
  expect(await git(directory, 'rev-parse', 'HEAD')).toBe(base.oid);
  expect(await git(directory, 'remote')).toBe('');
  expect(await git(directory, 'ls-tree', 'HEAD')).toBe('');
});

it('admits a bounded canonical remote pack and its owned in-flight temporary container', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-container-budget-')));
  roots.push(root);
  const directory = join(root, 'repository');
  const oid = 'a'.repeat(40);
  const base = await acquireRemoteRepositoryBase(
    {
      repositoryId: 'bounded',
      url: 'https://example.invalid/team/repo.git',
      directory,
      base: { kind: 'ref', ref: 'main' },
      signal: new AbortController().signal,
    },
    async (args, signal) => {
      if (args.includes('init'))
        await mkdir(join(directory, '.git', 'objects', 'pack'), { recursive: true });
      if (args.includes('fetch')) {
        const pack = join(directory, '.git', 'objects', 'pack', 'tmp_pack_owned');
        await writeFile(pack, '');
        await truncate(pack, 17 * 1024 * 1024);
        await new Promise((resolve) => setTimeout(resolve, 100));
        signal.throwIfAborted();
        await rename(pack, join(directory, '.git', 'objects', 'pack', `pack-${oid}.pack`));
      }
      return { stdout: args.includes('rev-parse') ? oid : '', stderr: '' };
    },
  );
  expect(base.oid).toBe(oid);
});

it.each([
  { name: 'noncanonical17', files: [['tmp_pack', 17]] },
  { name: 'temporary129', files: [['tmp_pack_owned', 129]] },
  { name: 'canonical129', files: [[`pack-${'a'.repeat(40)}.pack`, 129]] },
  {
    name: 'aggregate130',
    files: [
      [`pack-${'a'.repeat(40)}.pack`, 65],
      [`pack-${'a'.repeat(40)}.idx`, 65],
    ],
  },
])(
  'aborts an oversized $name in-flight remote store and joins its runner before refusing acquisition',
  async ({ files }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-budget-')));
    roots.push(root);
    const directory = join(root, 'repository');
    let stopped = false;
    await expect(
      acquireRemoteRepositoryBase(
        {
          repositoryId: 'bounded',
          url: 'https://example.invalid/team/repo.git',
          directory,
          base: { kind: 'ref', ref: 'main' },
          signal: new AbortController().signal,
        },
        async (args, signal) => {
          if (args.includes('init')) {
            await mkdir(join(directory, '.git', 'objects', 'pack'), { recursive: true });
            return { stdout: '', stderr: '' };
          }
          if (args.includes('fetch')) {
            for (const [name, sizeMiB] of files) {
              const pack = join(directory, '.git', 'objects', 'pack', String(name));
              await writeFile(pack, '');
              await truncate(pack, Number(sizeMiB) * 1024 * 1024);
            }
            return new Promise((_, reject) =>
              signal.addEventListener(
                'abort',
                () => {
                  stopped = true;
                  reject(signal.reason);
                },
                { once: true },
              ),
            );
          }
          throw Error('unexpected command');
        },
      ),
    ).rejects.toThrow('Repository acquisition exceeds its storage limit');
    expect(stopped).toBe(true);
  },
  5000,
);
it('refuses a large leftover temporary container once acquisition has stopped', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-leftover-budget-')));
  roots.push(root);
  const directory = join(root, 'repository');
  await expect(
    acquireRemoteRepositoryBase(
      {
        repositoryId: 'bounded',
        url: 'https://example.invalid/team/repo.git',
        directory,
        base: { kind: 'ref', ref: 'main' },
        signal: new AbortController().signal,
      },
      async (args) => {
        if (args.includes('init'))
          await mkdir(join(directory, '.git', 'objects', 'pack'), { recursive: true });
        if (args.includes('fetch')) {
          const pack = join(directory, '.git', 'objects', 'pack', 'tmp_pack_owned');
          await writeFile(pack, '');
          await truncate(pack, 17 * 1024 * 1024);
        }
        return { stdout: '', stderr: '' };
      },
    ),
  ).rejects.toThrow('Repository acquisition exceeds its storage limit');
});

const env = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const git = async (cwd: string, ...args: string[]) =>
  (await execute('/usr/bin/git', ['-C', cwd, ...args], { env })).stdout.trim();

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-base-')));
  roots.push(root);
  const source = join(root, 'source'),
    remote = join(root, 'upstream.git');
  await git(root, 'init', '-q', '-b', 'main', source);
  await git(source, 'config', 'user.name', 'Offline');
  await git(source, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'code.txt'), 'first');
  await git(source, 'add', '.');
  await git(source, 'commit', '-qm', 'first');
  const previous = await git(source, 'rev-parse', 'HEAD');
  await git(root, 'clone', '-q', '--bare', source, remote);
  await git(source, 'remote', 'add', 'origin', remote);
  await writeFile(join(source, 'code.txt'), 'fresh main');
  await git(source, 'commit', '-qam', 'fresh');
  await git(source, 'push', '-q', 'origin', 'main');
  const latest = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'checkout', '-qb', 'feature', previous);
  await writeFile(join(source, 'unfinished.txt'), 'preserve source');
  const calls: readonly string[][] = [];
  const run: LocalRepositoryRemoteGit = async (args, signal) => {
    (calls as string[][]).push([...args]);
    // Only this fixture transport substitutes its offline file remote. Product
    // commands continue to prohibit the file/ext remote helper protocols.
    return execute(
      '/usr/bin/git',
      args.map((arg) =>
        arg === 'https://example.invalid/team/repo.git'
          ? remote
          : arg === 'protocol.allow=never'
            ? 'protocol.allow=always'
            : arg,
      ),
      { env, signal },
    );
  };
  return { root, source, previous, latest, run, calls };
}

it('freshly acquires the remote default into independent storage and preserves dirty feature source', async () => {
  const f = await fixture();
  const directory = join(f.root, 'task');
  const base = await acquireRemoteRepositoryBase(
    {
      repositoryId: 'fixture',
      url: 'https://example.invalid/team/repo.git',
      directory,
      base: { kind: 'default' },
      signal: new AbortController().signal,
    },
    f.run,
  );
  expect(base).toMatchObject({
    repositoryId: 'fixture',
    oid: f.latest,
    branch: 'main',
    origin: 'remote',
  });
  expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(f.previous);
  expect(await git(f.source, 'status', '--porcelain')).toContain('unfinished.txt');
  expect(await git(directory, 'rev-parse', '--git-common-dir')).toBe('.git');
  expect(f.calls.some((args) => args.includes('--no-includes'))).toBe(false);
});

it('honors an explicit remote commit and fails instead of using stale local content', async () => {
  const f = await fixture();
  const base = await acquireRemoteRepositoryBase(
    {
      repositoryId: 'fixture',
      url: 'https://example.invalid/team/repo.git',
      directory: join(f.root, 'task'),
      base: { kind: 'ref', ref: f.previous },
      signal: new AbortController().signal,
    },
    f.run,
  );
  expect(base.oid).toBe(f.previous);
  await expect(
    acquireRemoteRepositoryBase(
      {
        repositoryId: 'fixture',
        url: 'https://example.invalid/team/repo.git',
        directory: join(f.root, 'unavailable'),
        base: { kind: 'default' },
        signal: new AbortController().signal,
      },
      async () => {
        throw Error('offline');
      },
    ),
  ).rejects.toThrow('Repository base acquisition failed');
});

it('reads remote URL bytes without executing includes, rewrites, hooks or credential helpers', async () => {
  const marker = '/never-executed';
  const remote = await localRepositoryRemote(
    Buffer.from(
      `[remote "origin"]\n url = git@example.invalid:team/repo.git\n[include]\n path = ${marker}\n[credential]\n helper = !touch ${marker}\n[url "ext::touch ${marker}"]\n insteadOf = git@example.invalid:\n`,
    ),
  );
  expect(remote).toBe('ssh://git@example.invalid/team/repo.git');
  await expect(
    localRepositoryRemote(Buffer.from('[remote "origin"]\n url = ext::touch /never\n')),
  ).rejects.toThrow('Repository remote is unsupported');
  await expect(
    localRepositoryRemote(
      Buffer.from('[remote "origin"]\n url = https://user:secret@example.invalid/repo\n'),
    ),
  ).rejects.toThrow('Repository remote is unsupported');
});

it('requires explicit valid local-ref intent and defaults omitted intent to remote default', () => {
  expect(RepositoryBaseIntentSchema.parse(undefined)).toEqual({ kind: 'default' });
  expect(RepositoryBaseIntentSchema.parse({ kind: 'ref', ref: 'HEAD' })).toEqual({
    kind: 'ref',
    ref: 'HEAD',
  });
  expect(() =>
    RepositoryBaseIntentSchema.parse({ kind: 'ref', ref: '--upload-pack=evil' }),
  ).toThrow();
  expect(() => RepositoryBaseIntentSchema.parse({ kind: 'ref', ref: '../main' })).toThrow();
});

it('resolves an explicit local branch independently of source HEAD without executing source configuration', async () => {
  const f = await fixture();
  const access = new LocalRepositoryReadAccess({
    deniedRoots: [],
    deadline: Date.now() + 30000,
    async assertReadable() {},
    captureReadAnchor: fixtureReadAnchor,
  });
  await access.pinRoot(f.source);
  await access.pinRoot(join(f.source, '.git'));
  const metadata = {
    path: f.source,
    gitDirectory: join(f.source, '.git'),
    commonDirectory: join(f.source, '.git'),
    objectFormat: 'sha1' as const,
    comparisonConfig: {},
  };
  expect(await readLocalRepositoryBaseReference(access, metadata, 'main')).toEqual({
    oid: f.latest,
    branch: 'main',
  });
  expect(await readLocalRepositoryBaseReference(access, metadata, 'HEAD')).toEqual({
    oid: f.previous,
    branch: 'feature',
  });
  expect(await readLocalRepositoryBaseReference(access, metadata, f.previous)).toEqual({
    oid: f.previous,
  });
  await access.verify();
});
