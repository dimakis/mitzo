import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { detectDefaultBranch, fetchWorktreeBase } from './worktree.js';
import { readOnlyGitExecutable, readOnlyGitExecutableAsync } from './read-only-git.js';
import { SessionRuntimeError } from './session-runtime-error.js';

const unavailable = () => Error('Original local repository is unavailable');
const gitArgs = (cwd: string, args: string[]) => [
  '--no-replace-objects',
  '-C',
  cwd,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  ...args,
];
const gitOptions = {
  encoding: 'utf8' as const,
  timeout: 5000,
  maxBuffer: 16384,
  env: {
    PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
  },
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(readOnlyGitExecutable(), gitArgs(cwd, args), gitOptions).trim();

/** Source capture runs on the controller event loop. These fixed rev-parse
 * reads cannot run hooks, fsmonitor or lazy-fetch helpers. Leave mutation and
 * default-fetch execution with their existing owners. Join close: execFile's
 * abort callback alone does not establish that its child has been collected. */
async function captureGit(cwd: string, signal: AbortSignal, ...args: string[]): Promise<string> {
  signal.throwIfAborted();
  // The per-probe deadline also covers executable resolution.
  const deadline = new AbortController();
  const timeout = setTimeout(
    () =>
      deadline.abort(new DOMException('Local repository source read timed out', 'TimeoutError')),
    gitOptions.timeout,
  );
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    // Resolve the selected developer Git without blocking the event loop. A bare
    // `git` on macOS re-enters the xcrun shim on every spawn, which is slow or
    // fails in the fenced child environment (no HOME/TMPDIR). Stop or the
    // deadline settles immediately; the shared lookup still fills the cache.
    const executable = await new Promise<string>((resolve, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
      readOnlyGitExecutableAsync().then(
        (path) => {
          combined.removeEventListener('abort', abort);
          resolve(path);
        },
        (error: unknown) => {
          combined.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
    combined.throwIfAborted();
    return await spawnCaptureGit(executable, cwd, args, combined);
  } finally {
    clearTimeout(timeout);
  }
}

function spawnCaptureGit(
  executable: string,
  cwd: string,
  args: string[],
  combined: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let failure: unknown;
    let output = '';
    const child = execFile(
      executable,
      gitArgs(cwd, args),
      {
        ...gitOptions,
        timeout: 0,
        signal: combined,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        failure =
          error?.code === 'ABORT_ERR' && combined.aborted
            ? combined.reason
            : error
              ? Object.assign(error, { stdout, stderr })
              : undefined;
        output = stdout;
      },
    );
    child.once('close', () => {
      if (failure !== undefined) reject(failure);
      else if (combined.aborted) reject(combined.reason);
      else resolve(output.trim());
    });
  });
}
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
  resolveDefault?: (
    source: LocalRepositorySource,
  ) => Promise<{ baseBranch: string; baseOid: string }>,
) {
  signal.throwIfAborted();
  const root = directory(path);
  const identity = (
    await captureGit(
      path,
      signal,
      'rev-parse',
      '--show-toplevel',
      '--path-format=absolute',
      '--git-common-dir',
    )
  ).split('\n');
  if (identity.length !== 2 || identity[0] !== path) throw unavailable();
  const commonDirectory = identity[1];
  const commonRoot = directory(commonDirectory);
  const localSource = { repositoryId, path, root, commonDirectory, commonRoot };
  if (startPoint === undefined && resolveDefault) {
    const selected = await resolveDefault(localSource);
    signal.throwIfAborted();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(selected.baseOid)) throw unavailable();
    return { localSource, ...selected };
  }
  const selectedRef = startPoint ?? detectDefaultBranch(path);
  const baseOid =
    startPoint === undefined
      ? await fetchWorktreeBase(path, signal, selectedRef)
      : await captureGit(
          path,
          signal,
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${startPoint}^{commit}`,
        );
  signal.throwIfAborted();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseOid)) throw unavailable();
  // HEAD is a valid source ref, but is a reserved Git branch name. Keep the
  // reservation's display branch valid for non-main and detached repositories.
  const branch =
    selectedRef === 'HEAD'
      ? await captureGit(path, signal, 'rev-parse', '--abbrev-ref', 'HEAD')
      : selectedRef;
  signal.throwIfAborted();
  const baseBranch = branch === 'HEAD' ? baseOid : branch;
  return {
    localSource,
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
    !isDeepStrictEqual(directory(source.commonDirectory), source.commonRoot)
  )
    throw unavailable();
  const output = git(
    source.path,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--verify',
    '--end-of-options',
    `${baseOid}^{commit}`,
  ).split('\n');
  if (output.length !== 2 || output[0] !== source.commonDirectory || output[1] !== baseOid)
    throw unavailable();
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
    // rev-parse emits the symbolic name above, then independently verifies the
    // peeled commit. Failure still rejects even though symbolic mode emits no
    // additional line for that object. Keep both checks in this one process.
    '--verify',
    '--end-of-options',
    'HEAD^{commit}',
  ).split('\n');
  if (
    output.length !== 4 ||
    output[0] !== directoryPath ||
    output[1] !== source.commonDirectory ||
    output[2] === source.commonDirectory
  )
    throw unavailable();
  directory(output[2]);
  directory(source.commonDirectory);
  if (output[3] !== `refs/heads/${branch}`)
    throw new SessionRuntimeError('workspace_branch_changed');
  return output[2];
}
