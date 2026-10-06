import { execFile } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { GithubSandboxInspection } from './connections/capabilities/github-publish-pr.js';
const exec = promisify(execFile);
interface Source {
  workspace: string;
  gitStorageRoots: readonly string[];
  repositoryPath: string;
  baseBranch: string;
  signal: AbortSignal;
}
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
function ref(value: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('.lock')
  )
    throw new Error('Git reference is invalid');
  return value;
}
function gitEnv() {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
  };
}
async function git(source: Source, args: readonly string[], maxBytes = 128 * 1024) {
  return exec(
    'git',
    [
      '-C',
      source.repositoryPath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      ...args,
    ],
    { env: gitEnv(), signal: source.signal, encoding: 'buffer', maxBuffer: maxBytes },
  );
}
/** Root and permitted Git storage are controller-owned session metadata, never model input. */
async function boundary(source: Source) {
  source.signal.throwIfAborted();
  if (
    (await realpath(source.workspace)) !== source.workspace ||
    !within(source.workspace, source.repositoryPath) ||
    resolve(source.repositoryPath) !== source.repositoryPath ||
    (await realpath(source.repositoryPath)) !== source.repositoryPath
  )
    throw new Error('Repository path escapes session workspace');
  if ((await lstat(join(source.repositoryPath, '.git'))).isSymbolicLink())
    throw new Error('Git storage is ambiguous');
  const dirs = await git(source, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  for (const path of dirs.stdout.toString('utf8').trim().split('\n')) {
    const absolute = resolve(source.repositoryPath, path);
    const canonical = await realpath(absolute);
    if (
      canonical !== absolute ||
      ![source.workspace, ...source.gitStorageRoots].some((root) => within(root, canonical))
    )
      throw new Error('Git storage escapes approved roots');
    try {
      if ((await readFile(join(canonical, 'objects/info/alternates'), 'utf8')).trim())
        throw new Error('Alternate Git storage is unavailable');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const part of ['objects', 'objects/pack', 'refs']) {
      try {
        if ((await realpath(join(canonical, part))) !== join(canonical, part))
          throw new Error('Git storage is ambiguous');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
export async function inspectHostGithubRepository(
  source: Source,
): Promise<GithubSandboxInspection> {
  ref(source.baseBranch);
  await boundary(source);
  const read = async (...args: string[]) =>
    (await git(source, args)).stdout.toString('utf8').trimEnd();
  const [status, sourceOid, sourceBranch, originUrl, count, files] = await Promise.all([
    read('status', '--porcelain=v1', '--untracked-files=all'),
    read('rev-parse', 'HEAD'),
    read('symbolic-ref', '--quiet', '--short', 'HEAD'),
    read('remote', 'get-url', 'origin'),
    read('rev-list', '--count', `origin/${source.baseBranch}..HEAD`),
    read(
      '-c',
      'core.quotepath=true',
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '--name-only',
      '--no-renames',
      `origin/${source.baseBranch}..HEAD`,
    ),
  ]);
  const commitsAhead = Number(count);
  ref(sourceBranch);
  if (
    !Number.isSafeInteger(commitsAhead) ||
    commitsAhead < 0 ||
    !/^[a-f0-9]{40,64}$/i.test(sourceOid)
  )
    throw new Error('Git inspection is invalid');
  return {
    canonicalRepositoryPath: source.repositoryPath,
    status,
    sourceOid,
    sourceBranch,
    originUrl,
    commitsAhead,
    changedFiles: [...new Set(files.split('\n').filter(Boolean))].sort(),
    defaultBranch: '',
    sourceBranchProtected: false,
    symlinkFree: true,
  };
}
export async function exportHostGithubBundle(
  source: Source & { sourceBranch: string; sourceOid: string; maxBytes: number },
): Promise<Buffer> {
  ref(source.sourceBranch);
  ref(source.baseBranch);
  await boundary(source);
  if (
    !Number.isSafeInteger(source.maxBytes) ||
    source.maxBytes < 1 ||
    !/^[a-f0-9]{40,64}$/i.test(source.sourceOid)
  )
    throw new Error('Bundle request is invalid');
  const current = (
    await git(source, ['rev-parse', 'HEAD', `refs/heads/${source.sourceBranch}`])
  ).stdout
    .toString('utf8')
    .trim()
    .split('\n');
  if (current.some((oid) => oid !== source.sourceOid)) throw new Error('Source commit changed');
  const result = await git(
    source,
    ['bundle', 'create', '-', `origin/${source.baseBranch}..${source.sourceBranch}`],
    source.maxBytes,
  );
  if (!result.stdout.length || result.stdout.length > source.maxBytes)
    throw new Error('Bundle exceeds limit');
  return result.stdout;
}
