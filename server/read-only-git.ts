import { execFileSync } from 'node:child_process';
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
