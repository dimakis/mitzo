import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep, join } from 'node:path';
import type { ProtectedSdkCommandRunner } from '../../../../server/protected-sdk-command.js';

/** Observe the real runner only in a caller-created synthetic fixture root.
 * All original arguments/options/result/error are forwarded unchanged. No env,
 * token, stdout, real credential/config or production process is captured. */
export function observePrivateTodoCommandFailure(
  original: ProtectedSdkCommandRunner,
  scope: { fixtureRoot: string; canonicalDb: string },
  record: (stage: string, facts: Record<string, unknown>) => Promise<void>,
): ProtectedSdkCommandRunner {
  if (!isAbsolute(scope.fixtureRoot) || !isAbsolute(scope.canonicalDb))
    throw Error('Private fixture paths required');
  return async (command, args, options) => {
    try {
      return await original(command, args, options);
    } catch (error) {
      const inside = relative(scope.fixtureRoot, args[0] ?? '');
      const selected =
        inside !== '..' &&
        !inside.startsWith('..' + sep) &&
        !isAbsolute(inside) &&
        options.env.TELOS_DB_PATH === scope.canonicalDb &&
        command === 'python3' &&
        args[0] === join(scope.fixtureRoot, 'command_center', 'todo_api.py');
      if (selected && error instanceof Error) {
        const diagnostic = error as Error & {
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
          stderr?: unknown;
        };
        const stderr = typeof diagnostic.stderr === 'string' ? diagnostic.stderr : undefined;
        const stderrBytes = stderr === undefined ? undefined : Buffer.from(stderr);
        try {
          await record('actual-private-protected-todo-failure-nonsecret-diagnostics', {
            message: diagnostic.message,
            code: diagnostic.code ?? null,
            signal: diagnostic.signal ?? null,
            killed: diagnostic.killed ?? null,
            stderr: stderrBytes?.subarray(0, 65536).toString(),
            stderrBytes: stderrBytes?.length ?? null,
            stderrTruncated: (stderrBytes?.length ?? 0) > 65536,
            stderrSHA256:
              stderrBytes === undefined
                ? null
                : createHash('sha256').update(stderrBytes).digest('hex'),
            command: 'python3',
            executionCwd: options.cwd,
            privateTodoScript: args[0],
            canonicalDb: scope.canonicalDb,
            noEnvironmentOrStdoutCaptured: true,
          });
        } catch {
          /* Diagnostic write failure must not replace the original command error. */
        }
      }
      throw error;
    }
  };
}
