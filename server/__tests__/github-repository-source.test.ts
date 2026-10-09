import { GitHubCliHostPublisher } from '../connections/capabilities/github-publish-pr-transport.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import type { AccountBinding } from '@mitzo/protocol';
import { executeTrustedGitCommit } from '../trusted-native-operation.js';
import { inspectHostGithubRepository, exportHostGithubBundle } from '../github-host-source.js';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, readFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalRepositorySelection,
  GithubRepositoryPreviewSchema,
  inspectGithubRepositorySource,
  prepareGithubRepositorySource,
} from '../github-repository-source.js';

const roots: string[] = [];
const services: RepositoryWorkspaces[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-source-')));
  roots.push(root);
  const source = join(root, 'upstream');
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'file.txt'), 'original\n');
  await writeFile(join(source, '.gitattributes'), '*.txt filter=untrusted');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'base');
  const oid = git(source, 'rev-parse', 'HEAD');
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === 'gh') {
      const endpoint = args.at(-1)!;
      return {
        stdout: JSON.stringify(
          endpoint.endsWith('/branches/main')
            ? { name: 'main', commit: { sha: oid } }
            : { full_name: 'example/repo', default_branch: 'main', size: 1, archived: false },
        ),
        stderr: '',
      };
    }
    const actual = args.map((value) =>
      args[0] === 'clone' && value === 'https://github.com/example/repo.git' ? source : value,
    );
    return {
      stdout: execFileSync(command, actual, {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }),
      stderr: '',
    };
  });
  const signal = new AbortController().signal;
  return { root, source, oid, git, run, signal };
}

it('accepts GitHub names and canonical URLs and refuses credentials and other hosts', () => {
  expect(canonicalRepositorySelection('Example/Repo')).toBe('example/repo');
  expect(canonicalRepositorySelection('https://github.com/Example/Repo.git')).toBe('example/repo');
  for (const value of [
    'https://token@github.com/example/repo',
    'https://evil.test/example/repo',
    'file:///tmp/repo',
    '--upload-pack=evil',
    'example/../repo',
    'https://github.com/example/repo?token=secret',
  ]) {
    expect(() => canonicalRepositorySelection(value)).toThrow();
  }
});

it('previews the canonical default branch and exact remote commit without cloning', async () => {
  const f = await fixture();
  expect(await inspectGithubRepositorySource('Example/Repo', f.signal, f.run)).toMatchObject({
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: f.oid,
  });
  expect(f.run.mock.calls.every(([command]) => command === 'gh')).toBe(true);
});

it('creates an independent feature checkout pinned to the preview without executing repository code', async () => {
  const f = await fixture();
  const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
  const target = join(f.root, 'task');
  const result = await prepareGithubRepositorySource(
    preview,
    target,
    'mitzo/task-123',
    f.signal,
    f.run,
  );
  expect(result).toMatchObject({ ...preview, directory: target, featureBranch: 'mitzo/task-123' });
  expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('original\n');
  expect(f.git(target, 'symbolic-ref', '--short', 'HEAD')).toBe('mitzo/task-123');
  expect(f.git(target, 'rev-parse', 'HEAD')).toBe(f.oid);
  expect(f.git(target, 'rev-parse', 'origin/main')).toBe(f.oid);
  expect(f.git(target, 'remote', 'get-url', 'origin')).toBe('https://github.com/example/repo.git');
  expect(await readFile(join(target, '.git/objects/info/alternates'), 'utf8').catch(() => '')).toBe(
    '',
  );
  await writeFile(join(target, 'file.txt'), 'task change\n');
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('original\n');
});

it('refuses a moved starting commit and cleans only its own preparation directory', async () => {
  const f = await fixture();
  const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
  await writeFile(join(f.source, 'file.txt'), 'upstream change\n');
  f.git(f.source, 'commit', '-qam', 'advance');
  const target = join(f.root, 'task');
  await expect(
    prepareGithubRepositorySource(preview, target, 'mitzo/task-123', f.signal, f.run),
  ).rejects.toThrow('Starting commit changed');
  await expect(access(target)).rejects.toThrow();
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('upstream change\n');
});

it('preserves an existing destination rather than overwriting it', async () => {
  const f = await fixture();
  const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
  await expect(
    prepareGithubRepositorySource(preview, f.source, 'mitzo/task-123', f.signal, f.run),
  ).rejects.toThrow();
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('original\n');
});

it('lets the independent checkout commit changes and export them through the existing publisher boundary', async () => {
  const f = await fixture();
  const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
  const target = join(f.root, 'publishable-task');
  await prepareGithubRepositorySource(preview, target, 'mitzo/task-123', f.signal, f.run);
  await writeFile(join(target, 'file.txt'), 'task change\n');
  f.git(target, 'add', 'file.txt');
  f.git(target, 'commit', '-qm', 'task change');
  const source = {
    workspace: target,
    gitStorageRoots: [],
    repositoryPath: target,
    baseBranch: 'main',
    signal: f.signal,
    privateDirectory: join(f.root, 'inspection'),
  };
  const inspection = await inspectHostGithubRepository(source);
  expect(inspection).toMatchObject({
    sourceBranch: 'mitzo/task-123',
    commitsAhead: 1,
    changedFiles: ['file.txt'],
    status: '',
  });
  const bundle = await exportHostGithubBundle({
    ...source,
    sourceBranch: 'mitzo/task-123',
    sourceOid: inspection.sourceOid,
    maxBytes: 1024 * 1024,
  });
  expect(bundle.length).toBeGreaterThan(0);
  expect(f.git(target, 'log', '-1', '--format=%an <%ae>')).toBe(
    'Mitzo Sandbox <sandbox@mitzo.invalid>',
  );
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('original\n');
});

async function claimedFixture() {
  const f = await fixture();
  const binding = {
    accountId: 'offline',
    provider: 'openai',
    model: 'fixture',
    profileRevision: 'v1',
  } as AccountBinding;
  const service = new RepositoryWorkspaces(join(f.root, 'private'), {
    authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
    inspect: (repository, signal) => inspectGithubRepositorySource(repository, signal, f.run),
    prepare: (preview, directory, branch, signal) =>
      prepareGithubRepositorySource(preview, directory, branch, signal, f.run),
  });
  services.push(service);
  const tasks = join(f.root, 'tasks');
  await mkdir(tasks);
  const preview = await service.preview(binding, 'github', 'example/repo', f.signal);
  await service.prepare(preview.id, binding, f.signal);
  const claimed = await service.claim(preview.id, binding, 'conversation', tasks, false);
  const task = await service.validateHostTask('conversation', claimed.directory!);
  return { ...f, service, target: claimed.directory!, task };
}

it('supports the native approved commit tool on a prepared standalone checkout', async () => {
  const f = await claimedFixture();
  const target = f.target;
  await writeFile(join(target, 'file.txt'), 'native task change\n');
  await executeTrustedGitCommit(
    target,
    ['file.txt'],
    'native task change',
    f.signal,
    undefined,
    undefined,
    undefined,
    f.task,
  );
  expect(f.git(target, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1');
  expect(f.git(target, 'status', '--porcelain')).toBe('');
  expect(await f.service.validateHostTask('conversation', target)).toEqual(f.task);
  await expect(
    executeTrustedGitCommit(
      f.source,
      ['file.txt'],
      'wrong workspace',
      f.signal,
      undefined,
      undefined,
      undefined,
      f.task,
    ),
  ).rejects.toThrow('verified repository task');
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('original\n');
});

it('refuses external object storage before committing an acquired standalone checkout', async () => {
  const f = await claimedFixture();
  const target = f.target;
  await writeFile(join(target, 'file.txt'), 'retained task edit\n');
  await writeFile(join(target, '.git/objects/info/alternates'), join(f.source, '.git/objects'));
  await expect(
    executeTrustedGitCommit(
      target,
      ['file.txt'],
      'must refuse',
      f.signal,
      undefined,
      undefined,
      undefined,
      f.task,
    ),
  ).rejects.toThrow('External standalone Git storage');
  expect(f.git(target, 'rev-parse', 'HEAD')).toBe(f.oid);
  expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('retained task edit\n');
});

it('refuses trusted commits to the primary standalone checkout without a controller task claim', async () => {
  const f = await fixture();
  const before = f.git(f.source, 'rev-parse', 'HEAD');
  await writeFile(join(f.source, 'file.txt'), 'primary checkout edit\n');
  await expect(
    executeTrustedGitCommit(f.source, ['file.txt'], 'must refuse', f.signal),
  ).rejects.toThrow('verified repository task');
  expect(f.git(f.source, 'rev-parse', 'HEAD')).toBe(before);
  expect(f.git(f.source, 'diff', '--cached')).toBe('');
});

it.each([
  ['Foo/a', 'foo/b'],
  ['É/a', 'E\u0301/b'],
  ['Foo', 'foo/b'],
])(
  'rejects normalized ancestor collisions between %s and %s before materialization',
  async (first, second) => {
    const f = await fixture();
    const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
    const blob = f.git(f.source, 'hash-object', '-w', 'file.txt');
    f.git(f.source, 'read-tree', '--empty');
    execFileSync('git', ['-C', f.source, 'update-index', '--index-info'], {
      input: `100644 ${blob}\t${first}\n100644 ${blob}\t${second}\n`,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    const tree = f.git(f.source, 'write-tree');
    const oid = f.git(f.source, 'commit-tree', tree, '-p', f.oid, '-m', 'ambiguous paths');
    f.git(f.source, 'update-ref', 'refs/heads/main', oid);
    const target = join(f.root, 'colliding-task');
    await expect(
      prepareGithubRepositorySource(
        { ...preview, baseOid: oid },
        target,
        'mitzo/task',
        f.signal,
        f.run,
      ),
    ).rejects.toThrow('Repository paths are unsupported');
    expect(f.run.mock.calls.some(([, args]) => args.includes('checkout-index'))).toBe(false);
    await expect(access(target)).rejects.toThrow();
  },
);

it('allows distinct files sharing the exact same directory spelling', async () => {
  const f = await fixture();
  await mkdir(join(f.source, 'Foo'));
  await writeFile(join(f.source, 'Foo', 'a'), 'one');
  await writeFile(join(f.source, 'Foo', 'b'), 'two');
  f.git(f.source, 'add', 'Foo');
  f.git(f.source, 'commit', '-qm', 'shared directory');
  const oid = f.git(f.source, 'rev-parse', 'HEAD');
  const target = join(f.root, 'shared-task');
  await prepareGithubRepositorySource(
    { repository: 'example/repo', baseBranch: 'main', baseOid: oid },
    target,
    'mitzo/task',
    f.signal,
    f.run,
  );
  expect(await readFile(join(target, 'Foo', 'a'), 'utf8')).toBe('one');
  expect(await readFile(join(target, 'Foo', 'b'), 'utf8')).toBe('two');
});

it.each(['release+fix', 'release@2026', 'résumé/next+patch'])(
  'previews and prepares a valid Git default branch %s',
  async (baseBranch) => {
    const f = await fixture();
    f.git(f.source, 'branch', '-m', baseBranch);
    const runGit = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args) =>
      command === 'gh'
        ? {
            stdout: JSON.stringify(
              args.at(-1)!.includes('/branches/')
                ? { name: baseBranch, commit: { sha: f.oid } }
                : {
                    full_name: 'example/repo',
                    default_branch: baseBranch,
                    size: 1,
                    archived: false,
                  },
            ),
            stderr: '',
          }
        : runGit(command, args),
    );
    const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
    expect(preview.baseBranch).toBe(baseBranch);
    const target = join(f.root, 'special-branch-task');
    await prepareGithubRepositorySource(preview, target, 'mitzo/task', f.signal, f.run);
    expect(f.git(target, 'rev-parse', `refs/remotes/origin/${baseBranch}`)).toBe(f.oid);
    expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('original\n');
    await writeFile(join(target, 'file.txt'), 'edited special branch\n');
    f.git(target, 'add', 'file.txt');
    f.git(target, 'commit', '-qm', 'edit');
    const source = {
      workspace: target,
      gitStorageRoots: [],
      repositoryPath: target,
      baseBranch,
      signal: f.signal,
      privateDirectory: join(f.root, 'publication-inspection'),
    };
    const inspection = await inspectHostGithubRepository(source);
    expect(inspection).toMatchObject({
      sourceBranch: 'mitzo/task',
      commitsAhead: 1,
      changedFiles: ['file.txt'],
    });
    expect(
      (
        await exportHostGithubBundle({
          ...source,
          sourceBranch: 'mitzo/task',
          sourceOid: inspection.sourceOid,
          maxBytes: 1024 * 1024,
        })
      ).length,
    ).toBeGreaterThan(0);
    const publisher = new GitHubCliHostPublisher(async (_command, args) => ({
      stdout: JSON.stringify(
        args.at(-1)!.includes('/branches/')
          ? { protected: false }
          : { full_name: 'example/repo', default_branch: baseBranch },
      ),
      stderr: '',
    }));
    expect(
      await publisher.policy({
        repository: 'example/repo',
        sourceBranch: 'mitzo/task',
        signal: f.signal,
      }),
    ).toMatchObject({ defaultBranch: baseBranch, sourceBranchProtected: false });
  },
);

it.each([
  'bad..branch',
  'bad@{branch',
  '.hidden',
  'bad.lock',
  'bad branch',
  'bad\\branch',
  'bad//branch',
  'bad:branch',
])('rejects invalid Git ref syntax %s', (baseBranch) => {
  expect(
    GithubRepositoryPreviewSchema.safeParse({
      repository: 'example/repo',
      baseBranch,
      baseOid: 'a'.repeat(40),
    }).success,
  ).toBe(false);
});

it('rejects an archived repository during preview before fetching its branch or downloading source', async () => {
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({
      full_name: 'example/repo',
      default_branch: 'main',
      size: 1,
      archived: true,
    }),
    stderr: '',
  }));
  await expect(
    inspectGithubRepositorySource('example/repo', new AbortController().signal, run),
  ).rejects.toThrow('Archived repositories cannot be published');
  expect(run).toHaveBeenCalledTimes(1);
});
