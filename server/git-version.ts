import { execFileSync } from 'child_process';

const GIT_TIMEOUT_MS = 5_000;
const REMOTE = 'origin';
const BRANCH = 'main';

export function getLocalCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function getRemoteCommit(): string | null {
  try {
    execFileSync('git', ['fetch', REMOTE, BRANCH, '--quiet'], {
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
    return execFileSync('git', ['rev-parse', `${REMOTE}/${BRANCH}`], {
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function isUpdateAvailable(): boolean {
  const local = getLocalCommit();
  if (!local) return false;
  const remote = getRemoteCommit();
  if (!remote) return false;
  return local !== remote;
}
