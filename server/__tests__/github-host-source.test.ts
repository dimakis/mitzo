import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, symlink, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectHostGithubRepository, exportHostGithubBundle } from '../github-host-source.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-host-publish-')));
  roots.push(root);
  const privateDirectory = await mkdtemp(join(tmpdir(), 'mitzo-git-private-'));
  roots.push(privateDirectory);
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
      { encoding: 'utf8' },
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
      privateDirectory,
      repositoryPath: root,
      baseBranch: 'main',
      signal: new AbortController().signal,
    },
  };
}
it('inspects and exports committed host work without network or credentials', async () => {
  const f = await fixture();
  const result = await inspectHostGithubRepository(f.input);
  expect(result).toMatchObject({
    canonicalRepositoryPath: f.root,
    sourceBranch: 'feature',
    commitsAhead: 1,
    changedFiles: ['note.txt'],
    symlinkFree: true,
    status: '',
  });
  const bundle = await exportHostGithubBundle({
    ...f.input,
    sourceBranch: 'feature',
    sourceOid: result.sourceOid,
    maxBytes: 1024 * 1024,
  });
  expect(bundle.toString('utf8', 0, 16)).toContain('git bundle');
  await expect(
    exportHostGithubBundle({
      ...f.input,
      sourceBranch: 'feature',
      sourceOid: '0'.repeat(40),
      maxBytes: 1024,
    }),
  ).rejects.toThrow();
});
it('rejects path escape and symlinked Git storage before reading it', async () => {
  const f = await fixture();
  const outside = await fixture();
  await expect(
    inspectHostGithubRepository({ ...f.input, repositoryPath: outside.root }),
  ).rejects.toThrow();
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
  expect(
    await inspectHostGithubRepository({ ...input, gitStorageRoots: [join(f.root, '.git')] }),
  ).toMatchObject({ sourceBranch: 'worktree-feature', commitsAhead: 1 });
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
