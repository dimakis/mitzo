import { execFileSync } from 'child_process';

const GIT_TIMEOUT_MS = 15_000;
const REMOTE = 'origin';

function gitOutput(args: string[], timeout = GIT_TIMEOUT_MS): string {
  return execFileSync('git', args, {
    stdio: 'pipe',
    timeout,
  })
    .toString()
    .trim();
}

function getDefaultBranch(): string {
  try {
    const ref = gitOutput(['symbolic-ref', `refs/remotes/${REMOTE}/HEAD`]);
    return ref.replace(`refs/remotes/${REMOTE}/`, '');
  } catch {
    return 'main';
  }
}

export function getLocalCommit(): string | null {
  try {
    return gitOutput(['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

export function getRemoteCommit(): string | null {
  try {
    const branch = getDefaultBranch();
    const output = gitOutput(['ls-remote', REMOTE, `refs/heads/${branch}`]);
    const sha = output.split(/\s/)[0];
    return sha || null;
  } catch {
    return null;
  }
}

export function isUpdateAvailable(): boolean {
  const local = getLocalCommit();
  if (!local) return false;
  const remote = getRemoteCommit();
  if (!remote) return false;
  if (local === remote) return false;
  try {
    gitOutput(['merge-base', '--is-ancestor', local, remote]);
    return true;
  } catch {
    return false;
  }
}
