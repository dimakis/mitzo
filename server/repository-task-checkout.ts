import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);

interface DirectoryIdentity {
  dev: number;
  ino: number;
}
/** Stored only in the controller's private claim ledger, never supplied by a tool input. */
export interface RepositoryTaskCheckout {
  directory: string;
  featureBranch: string;
  root: DirectoryIdentity;
  git: DirectoryIdentity;
}

export async function snapshotRepositoryTaskCheckout(
  directory: string,
  featureBranch: string,
): Promise<RepositoryTaskCheckout> {
  if (!/^mitzo\/[A-Za-z0-9._/-]+$/.test(featureBranch) || featureBranch.includes('..'))
    throw new Error('Invalid repository task branch');
  const gitDirectory = join(directory, '.git');
  const root = await lstat(directory);
  const git = await lstat(gitDirectory);
  if (
    !root.isDirectory() ||
    !git.isDirectory() ||
    (await realpath(directory)) !== directory ||
    (await realpath(gitDirectory)) !== gitDirectory
  )
    throw new Error('Retained repository task identity changed');
  const head = join(gitDirectory, 'HEAD');
  const ref = join(gitDirectory, 'refs', 'heads', featureBranch);
  for (const path of [head, ref]) {
    if (!(await lstat(path)).isFile() || (await realpath(path)) !== path)
      throw new Error('Retained repository task metadata is unavailable');
  }
  const oid = (await readFile(ref, 'utf8')).trim();
  if (
    (await readFile(head, 'utf8')).trim() !== `ref: refs/heads/${featureBranch}` ||
    !/^[a-f0-9]{40}$/.test(oid)
  )
    throw new Error('Retained repository task branch changed');
  const objects = join(gitDirectory, 'objects');
  if (!(await lstat(objects)).isDirectory() || (await realpath(objects)) !== objects)
    throw new Error('Retained repository task object storage changed');
  for (const name of ['info/alternates', 'info/http-alternates']) {
    const entry = await lstat(join(objects, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (entry) throw new Error('External standalone Git storage is unavailable');
  }
  // Verify the retained commit without project hooks, filters, lazy fetches or ambient credentials.
  await run(
    'git',
    [
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '--git-dir',
      gitDirectory,
      'cat-file',
      '-e',
      `${oid}^{commit}`,
    ],
    {
      cwd: directory,
      env: {
        PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_LAZY_FETCH: '1',
      },
      timeout: 5000,
      maxBuffer: 4096,
    },
  ).catch(() => {
    throw new Error('Retained repository task Git history is unavailable');
  });
  const afterRoot = await lstat(directory),
    afterGit = await lstat(gitDirectory);
  if (
    root.dev !== afterRoot.dev ||
    root.ino !== afterRoot.ino ||
    git.dev !== afterGit.dev ||
    git.ino !== afterGit.ino
  )
    throw new Error('Retained repository task identity changed');
  return {
    directory,
    featureBranch,
    root: { dev: root.dev, ino: root.ino },
    git: { dev: git.dev, ino: git.ino },
  };
}

export async function validateRepositoryTaskCheckout(
  directory: string,
  expected: RepositoryTaskCheckout | undefined,
): Promise<RepositoryTaskCheckout> {
  if (!expected || expected.directory !== directory)
    throw new Error('Standalone commits and resumes require a verified repository task');
  const current = await snapshotRepositoryTaskCheckout(directory, expected.featureBranch);
  if (
    current.root.dev !== expected.root.dev ||
    current.root.ino !== expected.root.ino ||
    current.git.dev !== expected.git.dev ||
    current.git.ino !== expected.git.ino
  )
    throw new Error('Retained repository task identity changed');
  return current;
}
