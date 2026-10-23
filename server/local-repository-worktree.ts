import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { detectDefaultBranch, fetchWorktreeBase } from './worktree.js';

const unavailable = () => Error('Original local repository is unavailable');
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '--no-replace-objects',
      '-C',
      cwd,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16384,
      env: {
        PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_LAZY_FETCH: '1',
      },
    },
  ).trim();
function directory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw unavailable();
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return { dev: stat.dev, ino: stat.ino };
}
export interface LocalRepositorySource {
  /** Server-captured path intent. Custody identity is not a filesystem grant. */
  selection?: 'existing';
  repositoryId: string;
  path: string;
  root: { dev: number; ino: number };
  commonDirectory: string;
  commonRoot: { dev: number; ino: number };
}
export async function captureLocalRepository(
  repositoryId: string,
  path: string,
  signal: AbortSignal,
  startPoint?: string,
) {
  signal.throwIfAborted();
  const root = directory(path);
  if (git(path, 'rev-parse', '--show-toplevel') !== path) throw unavailable();
  const commonDirectory = git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const commonRoot = directory(commonDirectory);
  const selectedRef = startPoint ?? detectDefaultBranch(path);
  const baseOid =
    startPoint === undefined
      ? await fetchWorktreeBase(path, signal)
      : git(path, 'rev-parse', '--verify', '--end-of-options', `${startPoint}^{commit}`);
  signal.throwIfAborted();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseOid)) throw unavailable();
  // HEAD is a valid source ref, but is a reserved Git branch name. Keep the
  // reservation's display branch valid for non-main and detached repositories.
  const branch =
    selectedRef === 'HEAD' ? git(path, 'rev-parse', '--abbrev-ref', 'HEAD') : selectedRef;
  const baseBranch = branch === 'HEAD' ? baseOid : branch;
  return {
    localSource: { repositoryId, path, root, commonDirectory, commonRoot },
    baseBranch,
    baseOid,
  };
}
export function assertLocalRepository(
  source: LocalRepositorySource,
  configured: string | undefined,
  baseOid: string,
) {
  if (
    configured !== source.path ||
    !isDeepStrictEqual(directory(source.path), source.root) ||
    !isDeepStrictEqual(directory(source.commonDirectory), source.commonRoot) ||
    git(source.path, 'rev-parse', '--path-format=absolute', '--git-common-dir') !==
      source.commonDirectory
  )
    throw unavailable();
  git(source.path, 'cat-file', '-e', `${baseOid}^{commit}`);
}
export function inspectLocalRepositoryWorktree(
  directoryPath: string,
  source: LocalRepositorySource,
  branch: string,
) {
  const output = git(
    directoryPath,
    'rev-parse',
    '--show-toplevel',
    '--path-format=absolute',
    '--git-common-dir',
    '--absolute-git-dir',
    '--symbolic-full-name',
    'HEAD',
  ).split('\n');
  if (
    output.length !== 4 ||
    output[0] !== directoryPath ||
    output[1] !== source.commonDirectory ||
    output[2] === source.commonDirectory ||
    output[3] !== `refs/heads/${branch}`
  )
    throw unavailable();
  directory(output[2]);
  directory(source.commonDirectory);
  git(directoryPath, 'cat-file', '-e', 'HEAD^{commit}');
  return output[2];
}
