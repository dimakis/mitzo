import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  writeFile,
  readFile,
  symlink,
  rm,
  realpath,
  access,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  inspectHostGithubRepository,
  exportHostGithubBundle,
  resolveHostGithubRepository,
} from '../github-host-source.js';
import {
  hostGithubPublishingSource,
  githubPublishingGitStorageRoots,
} from '../github-publishing-tool.js';
import { realpathSync } from 'node:fs';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(parent = tmpdir()) {
  const root = await realpath(await mkdtemp(join(parent, 'mitzo-host-publish-')));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
        },
      },
    ).trim();
  git('init', '-b', 'main');
  await writeFile(join(root, 'note.txt'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git('switch', '-c', 'feature');
  await writeFile(join(root, 'note.txt'), 'change');
  git('commit', '-qam', 'change');
  return {
    root,
    git,
    input: {
      workspace: root,
      gitStorageRoots: [] as string[],
      repositoryPath: root,
      baseBranch: 'main',
      signal: new AbortController().signal,
    },
  };
}
it('inspects and exports committed host work without network or credentials', async () => {
  const f = await fixture();
  vi.mocked(readdir).mockClear();
  const result = await inspectHostGithubRepository(f.input);
  expect(
    vi.mocked(readdir).mock.calls.filter(([path]) => path === join(f.root, '.git')),
  ).toHaveLength(1);
  expect(result).toMatchObject({
    canonicalRepositoryPath: f.root,
    sourceBranch: 'feature',
    commitsAhead: 1,
    changedFiles: ['note.txt'],
    symlinkFree: true,
  });
  // Prepared standalone tasks retain the acquired base in controller metadata,
  // while their private Git metadata contains only the feature branch.
  await writeFile(join(f.root, 'note.txt'), 'staged');
  f.git('add', 'note.txt');
  await writeFile(join(f.root, 'note.txt'), 'unstaged');
  await writeFile(join(f.root, 'preview.html'), 'untracked preview');
  const index = await readFile(join(f.root, '.git/index'));
  const pending = f.git('status', '--short');
  expect(await inspectHostGithubRepository(f.input)).toEqual(result);
  const baseOid = f.git('rev-parse', 'origin/main');
  const exportInput = {
    ...f.input,
    sourceBranch: 'feature',
    sourceOid: result.sourceOid,
    maxBytes: 1024 * 1024,
  };
  expect((await exportHostGithubBundle(exportInput)).toString('utf8', 0, 16)).toContain(
    'git bundle',
  );
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  await writeFile(join(f.root, '.git/shallow'), baseOid + '\n');
  const expiredSource = join(f.root, 'released-acquisition', '.git');
  // The completed standalone task has its own Git directory; source acquisition
  // storage may already be gone. The real stale-root failure is undefined here.
  expect(hostGithubPublishingSource({ cwd: f.root }, [expiredSource])).toBeUndefined();
  const configured = join(f.root, '.git');
  const storage = githubPublishingGitStorageRoots(
    { cwd: f.root },
    { directory: f.root, taskIdentity: { localSource: { commonDirectory: expiredSource } } },
    [configured, configured],
  );
  vi.mocked(realpathSync).mockClear();
  const source = hostGithubPublishingSource({ cwd: f.root }, storage, {
    directory: f.root,
    connectionId: 'local',
    repository: 'local/source-id',
    baseBranch: 'main',
    baseOid,
  });
  expect(source).toHaveProperty('gitStorageRoots', [configured]);
  expect(vi.mocked(realpathSync).mock.calls.map(([path]) => path)).toEqual([f.root, configured]);
  const preparedInput = { ...f.input, ...source };
  expect(source).toHaveProperty('preparedBase.baseOid', baseOid);
  expect(source!.preparedBase).not.toHaveProperty('repository');
  expect(await inspectHostGithubRepository(preparedInput)).toEqual(result);
  vi.mocked(readdir).mockClear();
  const bundle = await exportHostGithubBundle({
    ...preparedInput,
    sourceBranch: 'feature',
    sourceOid: result.sourceOid,
    maxBytes: 1024 * 1024,
  });
  expect(
    vi.mocked(readdir).mock.calls.filter(([path]) => path === join(f.root, '.git')),
  ).toHaveLength(1);
  expect(bundle.toString('utf8', 0, 16)).toContain('git bundle');
  expect(f.git('status', '--short')).toBe(pending);
  expect(await readFile(join(f.root, '.git/index'))).toEqual(index);
  expect(await readFile(join(f.root, 'preview.html'), 'utf8')).toBe('untracked preview');
  expect(await readFile(join(f.root, 'note.txt'), 'utf8')).toBe('unstaged');
  expect(f.git('show', 'HEAD:note.txt')).toBe('change');

  await expect(
    inspectHostGithubRepository({
      ...preparedInput,
      preparedBase: { ...source!.preparedBase!, repository: 'other/repo' },
    }),
  ).rejects.toThrow('Prepared publishing base does not match');
  // Other configured PR targets keep their real tracking-ref path; the main
  // preparation OID cannot stand in for an unrelated requested base.
  f.git('update-ref', 'refs/remotes/origin/release', baseOid);
  const alternate = { ...preparedInput, baseBranch: 'release' };
  expect(await inspectHostGithubRepository(alternate)).toEqual(result);
  expect(
    (await exportHostGithubBundle({ ...exportInput, ...alternate })).toString('utf8', 0, 16),
  ).toContain('git bundle');
  await expect(
    inspectHostGithubRepository({
      ...preparedInput,
      preparedBase: { ...source!.preparedBase!, baseBranch: 'other' },
    }),
  ).rejects.toThrow('Publishing base branch is unavailable');
  await expect(
    exportHostGithubBundle({
      ...f.input,
      sourceBranch: 'feature',
      sourceOid: '0'.repeat(40),
      maxBytes: 1024,
    }),
  ).rejects.toThrow();
});
it('scopes a prepared base to its own repository when publishing a nested checkout', async () => {
  const outer = await fixture();
  const nested = await fixture(outer.root);
  outer.git('remote', 'set-url', 'origin', 'https://github.com/example/outer.git');
  const source = hostGithubPublishingSource({ cwd: outer.root }, [], {
    directory: outer.root,
    connectionId: 'github',
    repository: 'example/outer',
    baseBranch: 'main',
    // Use an actual ancestor of both repositories. A missing nested tracking ref
    // must still fail rather than silently borrowing the outer acquisition OID.
    baseOid: outer.git('rev-parse', 'origin/main'),
  })!;
  const input = { ...nested.input, ...source };
  expect(source.preparedBase!.baseOid).toBe(nested.git('rev-parse', 'origin/main'));
  expect(await resolveHostGithubRepository(input)).toBe('example/repo');
  const inspected = await inspectHostGithubRepository(input);
  expect(inspected).toMatchObject({
    canonicalRepositoryPath: nested.root,
    sourceBranch: 'feature',
    commitsAhead: 1,
    changedFiles: ['note.txt'],
  });
  const exportInput = {
    ...input,
    sourceBranch: 'feature',
    sourceOid: inspected.sourceOid,
    maxBytes: 1024 * 1024,
  };
  await expect(
    inspectHostGithubRepository({
      ...input,
      preparedBase: {
        ...source.preparedBase!,
        repositoryPath: nested.root,
        repository: 'example/repo',
      },
    }),
  ).rejects.toThrow('Prepared publishing base does not match');
  expect((await exportHostGithubBundle(exportInput)).toString('utf8', 0, 16)).toContain(
    'git bundle',
  );
  nested.git('update-ref', '-d', 'refs/remotes/origin/main');
  await expect(inspectHostGithubRepository(input)).rejects.toThrow(
    'Publishing base branch is unavailable',
  );
  await expect(exportHostGithubBundle(exportInput)).rejects.toThrow(
    'Publishing base branch is unavailable',
  );
});
it('rejects path escape and symlinked Git storage before reading it', async () => {
  const f = await fixture();
  const outside = await fixture();
  await expect(
    inspectHostGithubRepository({ ...f.input, repositoryPath: outside.root }),
  ).rejects.toThrow();
  f.git('config', 'core.worktree', outside.root);
  await expect(inspectHostGithubRepository(f.input)).rejects.toThrow('workspace is ambiguous');
  f.git('config', '--unset', 'core.worktree');
  await rm(join(f.root, '.git'), { recursive: true });
  await symlink(join(outside.root, '.git'), join(f.root, '.git'));
  await expect(inspectHostGithubRepository(f.input)).rejects.toThrow();
});
it('permits registered host worktree storage and rejects unregistered storage', async () => {
  const f = await fixture();
  const worktree = join(f.root, 'worktree');
  f.git('worktree', 'add', '-b', 'worktree-feature', worktree, 'feature');
  const input = { ...f.input, workspace: worktree, repositoryPath: worktree };
  await expect(inspectHostGithubRepository(input)).rejects.toThrow();
  const task = {
    linkedGit: { directory: worktree },
    localSource: { commonDirectory: join(f.root, '.git') },
  };
  const source = hostGithubPublishingSource(
    { cwd: worktree },
    githubPublishingGitStorageRoots({ cwd: worktree }, { directory: worktree, taskIdentity: task }),
  );
  expect(await inspectHostGithubRepository({ ...input, ...source })).toMatchObject({
    sourceBranch: 'worktree-feature',
    commitsAhead: 1,
  });
  expect(
    hostGithubPublishingSource(
      { cwd: worktree },
      githubPublishingGitStorageRoots(
        { cwd: worktree },
        {
          directory: worktree,
          taskIdentity: {
            ...task,
            localSource: { commonDirectory: join(f.root, 'missing-shared-storage') },
          },
        },
      ),
    ),
  ).toBeUndefined();
  expect(
    githubPublishingGitStorageRoots(
      { cwd: worktree },
      { directory: '/foreign-workspace', taskIdentity: task },
    ),
  ).toEqual([]);
});

it('rejects symlinked objects and alternate object storage', async () => {
  const f = await fixture();
  const other = await fixture();
  await writeFile(join(f.root, '.git/objects/info/alternates'), join(other.root, '.git/objects'));
  await expect(inspectHostGithubRepository(f.input)).rejects.toThrow();
  await rm(join(f.root, '.git/objects/info/alternates'));
  const pack = join(f.root, '.git/objects/pack');
  await rm(pack, { recursive: true });
  await symlink(join(other.root, '.git/objects/pack'), pack);
  await expect(inspectHostGithubRepository(f.input)).rejects.toThrow();
});

it('does not execute repository-configured filters while inspecting committed source', async () => {
  const f = await fixture();
  const marker = join(f.root, 'filter-executed');
  await writeFile(join(f.root, '.gitattributes'), '*.txt filter=unsafe');
  f.git('add', '.gitattributes');
  f.git('commit', '-qm', 'attributes');
  f.git('config', 'filter.unsafe.clean', `touch ${marker}; cat`);
  f.git('config', 'filter.unsafe.required', 'true');
  await writeFile(join(f.root, 'note.txt'), 'different bytes to require a refresh');
  await inspectHostGithubRepository(f.input);
  await expect(access(marker)).rejects.toThrow();
});

it('resolves only canonical GitHub origins inside the session boundary', async () => {
  const f = await fixture();
  expect(await resolveHostGithubRepository(f.input)).toBe('example/repo');
  f.git('remote', 'set-url', 'origin', 'git@github.com:Example/Repo.git');
  expect(await resolveHostGithubRepository(f.input)).toBe('example/repo');
  f.git('remote', 'set-url', 'origin', 'https://token@github.com/example/repo.git');
  await expect(resolveHostGithubRepository(f.input)).rejects.toThrow();
  const other = await fixture();
  await expect(
    resolveHostGithubRepository({ ...f.input, repositoryPath: other.root }),
  ).rejects.toThrow();
});
