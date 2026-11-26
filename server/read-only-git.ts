import { execFile, execFileSync } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

const selectedDeveloperGit = () =>
  execFileSync('/usr/bin/xcrun', ['--find', 'git'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin' },
  });

/** macOS /usr/bin/git resolves developer tools on every invocation. Resolve it
 * once per short burst without caching repository state or changing Git flags.
 * Other hosts and unavailable developer tools retain normal PATH discovery. */
export function createReadOnlyGitResolver(
  platform: string = process.platform,
  lookup: () => string = selectedDeveloperGit,
  now: () => number = () => performance.now(),
): () => string {
  let selected = 'git',
    expires = -Infinity;
  return () => {
    if (platform !== 'darwin' || now() < expires) return selected;
    selected = 'git';
    try {
      const path = lookup().trim();
      if (isAbsolute(path) && basename(path) === 'git') selected = path;
    } catch {
      // Optimization only. Existing Git discovery remains authoritative.
    }
    expires = now() + 30_000;
    return selected;
  };
}

export const readOnlyGitExecutable = createReadOnlyGitResolver();

const selectedDeveloperGitAsync = () =>
  new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/xcrun',
      ['--find', 'git'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** Event-loop-safe variant for request paths. Without it, every bare `git`
 * spawn on macOS re-enters the /usr/bin/git xcrun shim, which is slow or fails
 * in a fenced child environment without HOME/TMPDIR. Concurrent callers share
 * one lookup; failures keep normal Git discovery, as above. */
export function createAsyncReadOnlyGitResolver(
  platform: string = process.platform,
  lookup: () => Promise<string> = selectedDeveloperGitAsync,
  now: () => number = () => performance.now(),
): () => Promise<string> {
  let selected = 'git',
    expires = -Infinity;
  let pending: Promise<string> | undefined;
  return () => {
    if (platform !== 'darwin' || now() < expires) return Promise.resolve(selected);
    pending ??= lookup()
      .then(
        (output) => {
          const path = output.trim();
          return isAbsolute(path) && basename(path) === 'git' ? path : 'git';
        },
        // Optimization only. Existing Git discovery remains authoritative.
        () => 'git',
      )
      .then((path) => {
        selected = path;
        expires = now() + 30_000;
        pending = undefined;
        return path;
      });
    return pending;
  };
}

export const readOnlyGitExecutableAsync = createAsyncReadOnlyGitResolver();
