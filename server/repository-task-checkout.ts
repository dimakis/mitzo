import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readOnlyGitExecutable } from './read-only-git.js';
import {
  inspectLocalRepositoryWorktree,
  type LocalRepositorySource,
} from './local-repository-worktree.js';

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
  localSource?: LocalRepositorySource;
  linkedGit?: { directory: string; identity: DirectoryIdentity };
}

export async function snapshotRepositoryTaskCheckout(
  directory: string,
  featureBranch: string,
  localSource?: LocalRepositorySource,
): Promise<RepositoryTaskCheckout> {
  if (!/^mitzo\/[A-Za-z0-9._/-]+$/.test(featureBranch) || featureBranch.includes('..'))
    throw new Error('Invalid repository task branch');
  const gitDirectory = join(directory, '.git');
  const root = await lstat(directory);
  const git = await lstat(gitDirectory);
  if (
    !root.isDirectory() ||
    (localSource ? !git.isFile() : !git.isDirectory()) ||
    (await realpath(directory)) !== directory ||
    (await realpath(gitDirectory)) !== gitDirectory
  )
    throw new Error('Retained repository task identity changed');
  if (localSource) {
    const linkedDirectory = inspectLocalRepositoryWorktree(directory, localSource, featureBranch);
    const linked = await lstat(linkedDirectory);
    const afterRoot = await lstat(directory),
      afterGit = await lstat(gitDirectory);
    if (
      afterRoot.dev !== root.dev ||
      afterRoot.ino !== root.ino ||
      afterGit.dev !== git.dev ||
      afterGit.ino !== git.ino
    )
      throw new Error('Retained local worktree identity changed');
    return {
      directory,
      featureBranch,
      root: { dev: root.dev, ino: root.ino },
      git: { dev: git.dev, ino: git.ino },
      localSource: structuredClone(localSource),
      linkedGit: { directory: linkedDirectory, identity: { dev: linked.dev, ino: linked.ino } },
    };
  }
  const head = join(gitDirectory, 'HEAD');
  const ref = join(gitDirectory, 'refs', 'heads', featureBranch);
  for (const path of [head, ref, join(gitDirectory, 'packed-refs')]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || path === head) throw error;
      return null;
    });
    if (info && (!info.isFile() || (await realpath(path)) !== path))
      throw new Error('Retained repository task metadata is unavailable');
  }
  if ((await readFile(head, 'utf8')).trim() !== `ref: refs/heads/${featureBranch}`)
    throw new Error('Retained repository task branch changed');
  // Qualify mutable standalone metadata before Git can load its local config,
  // common-store redirection or shallow/alternate paths. The bounded inspector
  // parses config bytes outside the repository without following includes.
  let objectFormat: 'sha1' | 'sha256' = 'sha1';
  for (const name of ['config', 'config.worktree']) {
    const path = join(gitDirectory, name);
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!entry && name === 'config.worktree') continue;
    if (
      !entry?.isFile() ||
      entry.nlink !== 1 ||
      entry.size > 65536 ||
      (await realpath(path)) !== path
    )
      throw new Error('Standalone Git configuration is unavailable');
    const parser = run(
      '/usr/bin/git',
      ['config', '--no-includes', '--file', '-', '--null', '--list'],
      {
        cwd: '/',
        timeout: 5000,
        maxBuffer: 131072,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    );
    parser.child.stdin?.end(await readFile(path));
    for (const setting of (await parser).stdout.split('\0').filter(Boolean)) {
      const separator = setting.indexOf('\n');
      const key = setting.slice(0, separator === -1 ? undefined : separator).toLowerCase();
      const value = separator === -1 ? undefined : setting.slice(separator + 1);
      if (
        /^include(if)?\./.test(key) ||
        (key.startsWith('extensions.') &&
          !['extensions.objectformat', 'extensions.worktreeconfig'].includes(key)) ||
        (key === 'core.worktree' && value !== directory) ||
        (key === 'core.bare' && !['false', 'no', 'off', '0'].includes(value?.toLowerCase() ?? ''))
      )
        throw new Error('External standalone Git configuration is unavailable');
      if (key === 'extensions.objectformat') {
        if (value !== 'sha1' && value !== 'sha256')
          throw new Error('Standalone Git object format is unavailable');
        objectFormat = value;
      }
    }
  }
  for (const name of ['commondir', 'shallow']) {
    const path = join(gitDirectory, name);
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!entry) continue;
    if (
      name === 'commondir' ||
      !entry.isFile() ||
      entry.nlink !== 1 ||
      entry.size > 65536 ||
      (await realpath(path)) !== path
    )
      throw new Error('External standalone Git storage is unavailable');
    const oidLength = objectFormat === 'sha256' ? 64 : 40;
    if (
      !(await readFile(path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .every((oid) => new RegExp(`^[a-f0-9]{${oidLength}}$`).test(oid))
    )
      throw new Error('Standalone shallow history is unavailable');
  }
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
  const runGit = (args: string[]) =>
    run(
      readOnlyGitExecutable(),
      [
        '--no-replace-objects',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '--git-dir',
        gitDirectory,
        ...args,
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
  const oid = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid))
    throw new Error('Retained repository task branch changed');
  // Verify the retained commit without project hooks, filters, lazy fetches or ambient credentials.
  await runGit(['cat-file', '-e', `${oid}^{commit}`]);
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
  const current = await snapshotRepositoryTaskCheckout(
    directory,
    expected.featureBranch,
    expected.linkedGit ? expected.localSource : undefined,
  );
  if (
    current.root.dev !== expected.root.dev ||
    current.root.ino !== expected.root.ino ||
    current.git.dev !== expected.git.dev ||
    current.git.ino !== expected.git.ino ||
    JSON.stringify(current.linkedGit) !== JSON.stringify(expected.linkedGit)
  )
    throw new Error('Retained repository task identity changed');
  return expected.localSource && !expected.linkedGit
    ? { ...current, localSource: structuredClone(expected.localSource) }
    : current;
}
