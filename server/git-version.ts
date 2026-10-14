import { execFile, execFileSync } from 'child_process';

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

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

export async function getRemoteCommit(): Promise<string | null> {
  try {
    await git(['fetch', REMOTE, BRANCH, '--quiet']);
    return await git(['rev-parse', `${REMOTE}/${BRANCH}`]);
  } catch {
    return null;
  }
}

let pendingUpdateCheck: Promise<boolean> | undefined;

/** Network Git operations must never block HTTP, streaming or approval delivery. */
export function isUpdateAvailable(): Promise<boolean> {
  if (pendingUpdateCheck) return pendingUpdateCheck;
  pendingUpdateCheck = (async () => {
    try {
      const local = await git(['rev-parse', 'HEAD']);
      if (!local) return false;
      const remote = await getRemoteCommit();
      return !!remote && local !== remote;
    } catch {
      return false;
    }
  })().finally(() => {
    pendingUpdateCheck = undefined;
  });
  return pendingUpdateCheck;
}
