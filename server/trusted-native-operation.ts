import { execFile } from 'node:child_process';
import { basename } from 'node:path';

const pathEnv = '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin';

function run(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputBytes: number;
    home?: string;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: {
          PATH: pathEnv,
          ...(options.home ? { HOME: options.home } : {}),
        },
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export async function executeTrustedGitHubRead(
  endpoint: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
  maxOutputBytes = 64 * 1024,
): Promise<string> {
  const home = process.env.HOME;
  if (!home) throw new Error('Trusted GitHub credentials are unavailable');
  return run('gh', ['api', '--method', 'GET', endpoint], {
    signal,
    timeoutMs,
    maxOutputBytes,
    home,
  });
}

export async function executeTrustedGitCommit(
  cwd: string,
  files: string[],
  message: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
  maxOutputBytes = 64 * 1024,
): Promise<string> {
  const existing = await run('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd,
    signal,
    timeoutMs,
    maxOutputBytes,
  });
  if (existing)
    throw new Error('Git index already contains staged changes; commit them separately');
  for (const file of files) {
    const name = basename(file).toLowerCase();
    if (
      name === '.env' ||
      name === 'auth.json' ||
      name === 'credentials.json' ||
      name === '.npmrc' ||
      name === '.pypirc' ||
      name === '.netrc' ||
      name === 'id_rsa' ||
      name === 'id_ed25519' ||
      name.endsWith('.token') ||
      name.endsWith('.pem') ||
      name.endsWith('.key')
    )
      throw new Error('Credential-like files cannot be committed by this operation');
  }
  await run('git', ['add', '--', ...files], { cwd, signal, timeoutMs, maxOutputBytes });
  const staged = await run('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd,
    signal,
    timeoutMs,
    maxOutputBytes,
  });
  const actual = staged.split('\0').filter(Boolean).sort();
  const expected = [...files].sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index]))
    throw new Error('Staged paths differ from the approved file list; commit cancelled');
  return run('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', message, '--', ...files], {
    cwd,
    signal,
    timeoutMs,
    maxOutputBytes,
  });
}
