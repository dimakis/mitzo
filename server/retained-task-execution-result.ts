import { taskExecutionFingerprint } from './task-execution-store.js';
import { resolve } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { taskExecutionSchema } from './task-execution-definitions.js';
import { getTaskExecutionStore } from './task-execution-runtime.js';

/** Called at the recovery mutation boundary, after matching the native tool's
 * request hash. Never invokes begin/finish, dispatches, or changes either receipt. */
export function hasRetainedTaskExecutionResult(
  sessionId: string,
  binding: AccountBinding,
  originalCwd: string,
  arguments_: Record<string, unknown>,
  result: { content: string; isError: boolean },
): boolean {
  try {
    const input = taskExecutionSchema.parse(arguments_);
    if (input.operation !== 'run' || !input.grantId || !input.requestId || !input.command)
      return false;
    // Do not resolve a historical symlink against today's filesystem. Only an
    // exact match with the original executor's canonical cwd fingerprint qualifies.
    const cwd = input.cwd ? resolve(originalCwd, input.cwd) : originalCwd;
    const fingerprint = taskExecutionFingerprint(
      'Bash',
      { command: input.command },
      cwd,
      input.timeoutMs,
    );
    return getTaskExecutionStore().hasMatchingCompletedRun({
      grantId: input.grantId,
      sessionId,
      requestId: input.requestId,
      fingerprint,
      cwd,
      binding,
      result,
    });
  } catch {
    return false;
  }
}
