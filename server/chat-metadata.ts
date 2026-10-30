import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { GIT_BRANCH_TIMEOUT_MS } from './constants.js';

/** Fixed, bounded metadata reads. No shared cache, shell, account selection or authority. */
async function readMetadata(
  program: 'git' | 'launchctl',
  args: string[],
  timeout: number,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { cwd, signal, timeout, maxBuffer: 8192, encoding: 'utf8' },
      (error, stdout) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        resolve(error ? null : stdout.trim());
      },
    );
  });
}
export async function isGitDirectory(cwd: string): Promise<boolean> {
  return (await readMetadata('git', ['-C', cwd, 'rev-parse', '--git-dir'], 5000)) !== null;
}
export async function readWorkspaceBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  return (
    (await readMetadata(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      GIT_BRANCH_TIMEOUT_MS,
      cwd,
      signal,
    )) ?? 'unknown'
  );
}
// launchctl resolves the live socket; an inherited socket can go stale after sleep.
export async function readSshAuthSock(signal?: AbortSignal): Promise<string | null> {
  if (platform() !== 'darwin') return null;
  return (
    (await readMetadata('launchctl', ['getenv', 'SSH_AUTH_SOCK'], 500, undefined, signal)) || null
  );
}
