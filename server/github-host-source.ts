import { isGitBranchName } from './git-branch.js';
import { execFile } from 'node:child_process';
import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { githubRepositoryFromOrigin } from './connections/capabilities/github-publish-pr.js';
import type { GithubSandboxInspection } from './connections/capabilities/github-publish-pr.js';
import { GithubSeedPublicationError } from './github-seeded-source.js';
import { GithubPublicationValidationError } from './github-publication-preflight.js';
const exec = promisify(execFile);
/** Controller-captured acquisition metadata, never accepted from tool input. */
export interface PreparedGithubBase {
  repositoryPath: string;
  /** GitHub acquisitions have a canonical identity. Local preparations use a
   * synthetic controller label; their actual origin is authorized separately. */
  repository?: string;
  baseBranch: string;
  baseOid: string;
}
interface Source {
  workspace: string;
  gitStorageRoots: readonly string[];
  repositoryPath: string;
  baseBranch: string;
  signal: AbortSignal;
  preparedBase?: PreparedGithubBase;
}
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
function ref(value: string) {
  if (!isGitBranchName(value)) throw new Error('Git reference is invalid');
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
    GIT_NO_REPLACE_OBJECTS: '1',
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
async function rejectLinkedStorage(root: string) {
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 100_000 || entry.isSymbolicLink())
        throw new Error('Git storage is ambiguous');
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
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
  const dirs = await git(source, [
    'rev-parse',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
  ]);
  const [top, ...storage] = dirs.stdout.toString('utf8').trim().split('\n');
  if (!top || (await realpath(top)) !== source.repositoryPath)
    throw new Error('Repository workspace is ambiguous');
  const storageDirectories = new Set(storage.map((path) => resolve(source.repositoryPath, path)));
  for (const absolute of storageDirectories) {
    const canonical = await realpath(absolute);
    if (
      canonical !== absolute ||
      ![source.workspace, ...source.gitStorageRoots].some((root) => within(root, canonical))
    )
      throw new Error('Git storage escapes approved roots');
    await rejectLinkedStorage(canonical);
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
export async function readHostGithubOrigin(source: Source): Promise<string> {
  await boundary(source);
  try {
    return (await git(source, ['config', '--local', '--get', 'remote.origin.url'], 4096)).stdout
      .toString('utf8')
      .trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return '';
    throw error;
  }
}
export async function resolveHostGithubRepository(source: Source): Promise<string> {
  const origin = await readHostGithubOrigin(source);
  if (!origin)
    throw new GithubSeedPublicationError(
      'REPOSITORY_ORIGIN_MISSING',
      'Repository has no origin remote',
    );
  return githubRepositoryFromOrigin(origin);
}
export async function inspectHostGithubSeed(source: Source) {
  await boundary(source);
  const read = async (...args: string[]) =>
    (await git(source, args)).stdout.toString('utf8').trim();
  const roots = (await read('rev-list', '--max-parents=0', 'HEAD')).split('\n');
  if (roots.length !== 1 || !/^[a-f0-9]{40}$/.test(roots[0]!))
    throw new GithubSeedPublicationError(
      'SEEDED_HISTORY_INVALID',
      'Seeded workspace history has no unambiguous baseline',
    );
  const seedOid = roots[0]!;
  const [originalSourceOid, sourceBranch, seedTreeOid, count, files] = await Promise.all([
    read('rev-parse', 'HEAD'),
    read('symbolic-ref', '--quiet', '--short', 'HEAD'),
    read('rev-parse', seedOid + '^{tree}'),
    read('rev-list', '--count', seedOid + '..HEAD'),
    read(
      '-c',
      'core.quotepath=true',
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '--name-only',
      '--no-renames',
      seedOid + '..HEAD',
    ),
  ]);
  ref(sourceBranch);
  const commitsAhead = Number(count);
  if (
    !/^[a-f0-9]{40}$/.test(originalSourceOid) ||
    !Number.isSafeInteger(commitsAhead) ||
    commitsAhead < 1
  )
    throw new GithubSeedPublicationError(
      'SEEDED_HISTORY_INVALID',
      'Seeded workspace has no committed task change',
    );
  return {
    seedOid,
    seedTreeOid,
    originalSourceOid,
    sourceBranch,
    commitsAhead,
    changedFiles: [...new Set(files.split('\n').filter(Boolean))].sort(),
  };
}
export async function exportHostGithubSeedPatch(
  source: Source & { seedOid: string; originalSourceOid: string },
): Promise<Buffer> {
  await boundary(source);
  if (![source.seedOid, source.originalSourceOid].every((v) => /^[a-f0-9]{40}$/.test(v)))
    throw new GithubSeedPublicationError(
      'SEEDED_SOURCE_INVALID',
      'Seed commit selection is invalid',
    );
  const result = await git(
    source,
    [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      source.seedOid,
      source.originalSourceOid,
      '--',
    ],
    4 * 1024 * 1024,
  );
  if (!result.stdout.length)
    throw new GithubSeedPublicationError('SEEDED_EXPORT_INVALID', 'Seeded change export is empty');
  return result.stdout;
}
export async function inspectHostGithubRepository(
  source: Source,
): Promise<GithubSandboxInspection> {
  ref(source.baseBranch);
  await boundary(source);
  const originUrl = (await git(source, ['remote', 'get-url', 'origin'])).stdout
    .toString('utf8')
    .trim();
  const base = await publicationBase(source, originUrl);
  const read = async (...args: string[]) =>
    (await git(source, args)).stdout.toString('utf8').trimEnd();
  const [sourceOid, sourceBranch, count, files] = await Promise.all([
    read('rev-parse', 'HEAD'),
    read('symbolic-ref', '--quiet', '--short', 'HEAD'),
    read('rev-list', '--count', `${base}..HEAD`),
    read(
      '-c',
      'core.quotepath=true',
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '--name-only',
      '--no-renames',
      `${base}..HEAD`,
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
/** Prepared tasks deliberately own only their feature ref. Use their verified
 * acquisition OID for both inspection and export; never guess from HEAD or
 * fetch/mutate an active task just to reconstruct a missing tracking ref. */
async function publicationBase(source: Source, originUrl?: string): Promise<string> {
  const selected = source.preparedBase;
  if (
    selected &&
    (selected.repositoryPath !== source.repositoryPath ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(selected.baseOid) ||
      (selected.repository !== undefined &&
        githubRepositoryFromOrigin(
          originUrl ??
            (await git(source, ['remote', 'get-url', 'origin'])).stdout.toString('utf8').trim(),
        ) !== selected.repository))
  )
    throw new GithubPublicationValidationError(
      'Prepared publishing base does not match the selected repository',
    );
  if (!selected || selected.baseBranch !== source.baseBranch) {
    try {
      return (
        await git(source, [
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${source.baseBranch}^{commit}`,
        ])
      ).stdout
        .toString('utf8')
        .trim();
    } catch {
      source.signal.throwIfAborted();
      throw new GithubPublicationValidationError(
        'Publishing base branch is unavailable in this checkout and no matching prepared base was retained',
      );
    }
  }
  try {
    await git(source, ['merge-base', '--is-ancestor', selected.baseOid, 'HEAD']);
  } catch {
    source.signal.throwIfAborted();
    throw new GithubPublicationValidationError(
      'Prepared publishing base is unavailable in the current task history',
    );
  }
  return selected.baseOid;
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
  const base = await publicationBase(source);
  const result = await git(
    source,
    ['bundle', 'create', '-', `${base}..${source.sourceBranch}`],
    source.maxBytes,
  );
  if (!result.stdout.length || result.stdout.length > source.maxBytes)
    throw new Error('Bundle exceeds limit');
  return result.stdout;
}
