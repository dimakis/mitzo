import { execFile, spawn } from 'node:child_process';
import { dirname } from 'node:path';

/** Cancellation could not prove every acquisition writer stopped. The source
 * owner must preserve its recorded scratch/operation and refuse automatic replay. */
export class RepositoryHostProcessUncertainError extends Error {
  readonly preserveScratch = true;
  constructor(readonly processGroupId?: number) {
    super(
      'Repository acquisition process shutdown could not be verified; preserve its owned scratch',
    );
  }
}

/** Capture the configured host GitHub login once for an acquisition. Source
 * repository config, shell startup files and Git helpers never participate. */
export function captureRepositoryHostGit(remote = 'https://github.com/') {
  const endpoint = new URL(remote);
  const github = endpoint.hostname === 'github.com';
  const ssh = endpoint.protocol === 'ssh:';
  const token = github ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN : undefined;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/nonexistent',
    ...(github && process.env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } : {}),
    ...(token ? { GH_TOKEN: token } : {}),
    ...(github ? { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ATTR_NOSYSTEM: '1',
    ...(ssh
      ? {
          ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
          GIT_SSH_COMMAND:
            '/usr/bin/ssh -F /dev/null -oBatchMode=yes -oStrictHostKeyChecking=yes -oForwardAgent=no -oClearAllForwardings=yes -oControlMaster=no -oControlPath=none -oIdentityFile=none',
        }
      : {}),
  };
  const execute = async (
    command: string,
    args: readonly string[],
    directory: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ stdout: string; stderr: string }> => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(deadline) || Date.now() >= deadline)
      throw Error('Repository acquisition expired');
    if (process.platform === 'win32')
      throw Error('Repository acquisition process groups unavailable');
    let cancellation: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let pid: number | undefined;
    let cancellationStarted!: () => void;
    const cancelling = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    const failed = () => Error('Repository host acquisition failed; check repository access');
    const signalGroup = (kind: NodeJS.Signals) => {
      if (!pid) return;
      try {
        process.kill(-pid, kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw new RepositoryHostProcessUncertainError(pid);
      }
    };
    const cancel = (reason: Error) => {
      cancellation ??= reason;
      cancellationStarted();
      try {
        signalGroup('SIGTERM');
      } catch {
        cancellation = new RepositoryHostProcessUncertainError(pid);
      }
      escalation ??= setTimeout(() => {
        try {
          signalGroup('SIGKILL');
        } catch {
          cancellation = new RepositoryHostProcessUncertainError(pid);
        }
      }, 100);
    };
    const groupStopped = async () => {
      if (!pid) return true;
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw new RepositoryHostProcessUncertainError(pid);
      }
      // macOS may briefly retain reparented zombies after SIGKILL. They cannot
      // write or spawn children. Query only numeric groups/state, never command
      // arguments, credentials or another task's process content.
      const state = await new Promise<string>((resolve, reject) => {
        execFile(
          '/bin/ps',
          ['-A', '-o', 'pgid=', '-o', 'stat='],
          {
            env: { PATH: '/usr/bin:/bin' },
            timeout: 1000,
            maxBuffer: 1048576,
          },
          (error, output) =>
            error ? reject(new RepositoryHostProcessUncertainError(pid)) : resolve(output),
        );
      });
      const members = state
        .split('\n')
        .map((row) => row.trim().split(/\s+/))
        .filter(([group]) => Number(group) === pid);
      return members.every(([, status]) => /^Z/.test(status ?? ''));
    };
    const chunks: Buffer[] = [];
    let child!: ReturnType<typeof spawn>;
    const completed = new Promise<{ error: Error | null; stdout: string }>((resolve) => {
      child = spawn(command, [...args], {
        cwd: directory,
        env: { ...env, GIT_CEILING_DIRECTORIES: directory },
        // execFile does not forward detached to spawn. Own the actual group and
        // explicitly join cancellation instead of its leader-only signal option.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      pid = child.pid;
      let output = 0;
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          output += bytes.length;
          if (output > 128 * 1024) cancel(failed());
          else if (stream === child.stdout) chunks.push(bytes);
        });
      child.once('error', () => resolve({ error: failed(), stdout: '' }));
      child.once('close', (code) =>
        resolve({
          error: code === 0 ? null : failed(),
          stdout: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    const onAbort = () => cancel(Error('Repository acquisition cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timeout = setTimeout(
      () => cancel(Error('Repository acquisition expired')),
      Math.min(30000, deadline - Date.now()),
    );
    try {
      const result = await Promise.race([completed, cancelling.then(() => undefined)]);
      if (result?.error) cancel(failed());
      if (!pid) {
        if (!result?.error) throw new RepositoryHostProcessUncertainError(pid);
        throw failed();
      }
      if (!(await groupStopped())) cancel(failed());
      if (cancellation) {
        // A killed leader is insufficient. Join every runnable group member,
        // escalating while its exact operation remains responsible for scratch.
        const until = Date.now() + 2000;
        while (!(await groupStopped())) {
          if (Date.now() >= until) throw new RepositoryHostProcessUncertainError(pid);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw cancellation;
      }
      signal.throwIfAborted();
      if (!result) throw new RepositoryHostProcessUncertainError(pid);
      return {
        stdout: token ? result.stdout.split(token).join('[REDACTED]') : result.stdout,
        stderr: '',
      };
    } catch (error) {
      if (error instanceof RepositoryHostProcessUncertainError) {
        try {
          signalGroup('SIGKILL');
        } catch {
          /* Retain scratch on uncertain shutdown. */
        }
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener('abort', onAbort);
    }
  };
  return Object.freeze({
    async identity(options: { directory: string; signal: AbortSignal; deadline: number }) {
      const result = await execute(
        'gh',
        ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
        dirname(options.directory),
        options.signal,
        options.deadline,
      );
      const login = result.stdout.trim();
      if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login))
        throw Error('Host GitHub identity unavailable');
      return login;
    },
    async run(
      args: readonly string[],
      options: { directory: string; signal: AbortSignal; deadline: number },
    ) {
      // Insert the sole code-owned credential helper after the acquisition's
      // explicit helper reset and before its fixed Git subcommand.
      const command = args.findIndex((value) =>
        ['ls-remote', 'init', 'fetch', 'rev-parse', 'symbolic-ref', 'update-ref'].includes(value),
      );
      if (command < 0) throw Error('Repository acquisition command unavailable');
      const isolated = [
        ...args.slice(0, command),
        '-c',
        'credential.helper=',
        '-c',
        github
          ? 'credential.https://github.com.helper=!gh auth git-credential'
          : process.platform === 'darwin' && !ssh
            ? 'credential.helper=osxkeychain'
            : 'credential.helper=',
        '-c',
        'credential.useHttpPath=true',
        '-c',
        'http.followRedirects=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args.slice(command),
      ];
      return execute(
        '/usr/bin/git',
        isolated,
        dirname(options.directory),
        options.signal,
        options.deadline,
      );
    },
  });
}
