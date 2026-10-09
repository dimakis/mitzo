import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  GithubNotFoundError,
  type GithubHostCommandRunner,
} from './connections/capabilities/github-publish-pr-transport.js';

function environment(): NodeJS.ProcessEnv {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    ...(token
      ? {
          GH_TOKEN: token,
          GITHUB_TOKEN: token,
          GIT_CONFIG_KEY_2: 'credential.helper',
          GIT_CONFIG_VALUE_2:
            '!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f',
        }
      : {
          // Consult only the enrolled gh account for this canonical host, without
          // inheriting global Git helpers or exporting its stored credentials.
          GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
          GIT_CONFIG_VALUE_2: '!gh auth git-credential',
        }),
  };
}
function safeCause(error: unknown): Error {
  const cause = new Error('Controller command failed');
  if (error && typeof error === 'object' && 'code' in error) {
    const code = error.code;
    if (
      (typeof code === 'number' && Number.isSafeInteger(code)) ||
      (typeof code === 'string' &&
        [
          'ENOENT',
          'EACCES',
          'ETIMEDOUT',
          'ABORT_ERR',
          'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        ].includes(code))
    )
      Object.assign(cause, { code });
  }
  return cause;
}
/** Code-owned host operations only. Credentials never enter argv, children beyond Git/gh, or diagnostics. */
export const knowledgeHostCommand: GithubHostCommandRunner = async (command, args, signal) => {
  if (command !== 'git' && command !== 'gh')
    throw new Error('Knowledge host command is not allowed');
  signal.throwIfAborted();
  const env = environment();
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        env,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        timeout: 30_000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const cause = safeCause(error);
          reject(
            /\b404\b/.test(stderr || ('stderr' in error ? String(error.stderr) : ''))
              ? new GithubNotFoundError(cause)
              : new Error('GitHub host operation failed', { cause }),
          );
        } else {
          const redact = (value: string) =>
            env.GH_TOKEN ? value.split(env.GH_TOKEN).join('[REDACTED]') : value;
          resolve({ stdout: redact(stdout), stderr: redact(stderr) });
        }
      },
    );
  });
  signal.throwIfAborted();
  return result;
};
