import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { z } from 'zod';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import { createNativeToolExecutor } from './native-tool-executor.js';
import { callbackOutcome, copyCallbackOutcome, retainCallbackOutcome } from './turn-callbacks.js';
import type { ProfileToolCall } from './session-profile-tools.js';
import type { taskExecutionSchema } from './task-execution-definitions.js';
import type { TaskExecutionGrant, TaskExecutionStore } from './task-execution-store.js';
import { createLogger } from './logger.js';
const log = createLogger('task-execution');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function executeTaskOperation(options: {
  input: z.infer<typeof taskExecutionSchema>;
  grant: TaskExecutionGrant;
  sessionId: string;
  session: ManagedSession;
  registry: SessionRegistry;
  clientId: string;
  call: ProfileToolCall;
  store: TaskExecutionStore;
  signal: AbortSignal;
  assertGrant(): TaskExecutionGrant;
  assertRuntimeCurrent(): Promise<void>;
}): Promise<{ content: string; isError: boolean }> {
  const {
    input,
    grant,
    sessionId,
    session,
    registry,
    clientId,
    call,
    store,
    signal,
    assertGrant,
    assertRuntimeCurrent,
  } = options;
  let releaseRun: (() => void) | undefined;
  try {
    if (!input.requestId) throw Error('Task execution requires a stable requestId');
    const toolName =
      input.operation === 'run'
        ? 'Bash'
        : input.operation === 'commit'
          ? 'GitCommit'
          : 'GitHubRead';
    const exact: Record<string, unknown> = {};
    if (toolName === 'Bash') {
      if (!input.command) throw Error('Task run requires command');
      exact.command = input.command;
    } else if (toolName === 'GitCommit') {
      if (!input.files || !input.message) throw Error('Task commit requires files and message');
      exact.files = input.files;
      exact.message = input.message;
    } else {
      const repository = /^\/repos\/([^/?]+\/[^/?]+)(?:[/?]|$)/.exec(input.endpoint ?? '')?.[1];
      if (!repository || !grant.repositories.includes(repository))
        throw Error('Repository is outside the approved task read scope');
      exact.endpoint = input.endpoint;
      exact.access = input.access ?? 'authenticated';
      if (input.view) exact.view = input.view;
    }
    const cwd = input.cwd ? realpathSync(resolve(session.cwd!, input.cwd)) : session.cwd!;
    if (
      !isAbsolute(cwd) ||
      !grant.members
        .find((member) => member.sessionId === sessionId)!
        .roots.some((root) => cwd === root || cwd.startsWith(root + '/'))
    )
      throw Error('Command directory is outside the selected task roots');
    const before = store.begin(
      grant.id,
      sessionId,
      input.requestId,
      hash([toolName, exact, cwd, input.timeoutMs ?? 60000]),
    );
    if (before.state === 'completed') {
      assertGrant();
      // Only a positively settled executor result reaches the completed ledger.
      return retainCallbackOutcome(before.result, 'settled');
    }
    const revoked = new AbortController();
    const unsubscribe = store.onRevoked(grant.id, () =>
      revoked.abort(Error('Task authorization was revoked')),
    );
    const expiry = setTimeout(
      () => revoked.abort(Error('Task authorization expired')),
      Math.max(0, grant.expiresAt - Date.now()),
    );
    releaseRun = () => {
      clearTimeout(expiry);
      unsubscribe();
    };
    const runSignal = AbortSignal.any([signal, revoked.signal]);
    const assertEffect = () => {
      runSignal.throwIfAborted();
      assertGrant();
      if (realpathSync(cwd) !== cwd) throw Error('Task command directory changed');
    };
    const execute = createNativeToolExecutor(clientId, registry, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin' },
      ...(grant.network === 'none'
        ? {}
        : {
            networkAccess:
              grant.network === 'loopback' ? ('loopback' as const) : ('approved-command' as const),
          }),
      timeoutMs: input.timeoutMs ?? 60000,
      maxOutputBytes: 65536,
      assertRuntimeCurrent: assertEffect,
      assertRuntimeCurrentAsync: async () => {
        await assertRuntimeCurrent();
        assertEffect();
      },
      taskAuthorization: {
        grantId: grant.id,
        toolName,
        input: exact,
        cwd,
        assertCurrentSync: assertEffect,
      },
    });
    const output = await execute(
      { type: 'tool_use', id: call.callId, name: toolName, input: exact },
      runSignal,
    );
    const result = copyCallbackOutcome(output, {
      content: typeof output.content === 'string' ? output.content : JSON.stringify(output.content),
      isError: output.is_error === true,
    });
    if (callbackOutcome(output) === 'unknown') {
      log.warn('Task operation outcome retained as uncertain', {
        grantId: grant.id,
        sessionId,
        requestId: input.requestId,
        toolName,
      });
      assertEffect();
      return {
        content: JSON.stringify({
          ...result,
          state: 'uncertain',
          requestId: input.requestId,
          recovery:
            'Inspect the existing workspace and TaskExecution status with this grantId/requestId; the operation will not be automatically repeated.',
        }),
        isError: true,
      };
    }
    store.finish(grant.id, sessionId, input.requestId, result);
    assertEffect();
    log.info('Task operation completed', {
      grantId: grant.id,
      sessionId,
      requestId: input.requestId,
      toolName,
      isError: result.isError,
    });
    return result;
  } finally {
    releaseRun?.();
  }
}
