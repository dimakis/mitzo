import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { Query, query } from '@anthropic-ai/claude-agent-sdk';

/** A protocol peer only: never creates an OS process, accesses credentials or calls a model. */
export function sdkFixtureBoundary() {
  return {
    credentialIsolation: false,
    deniedRoots: [],
    spawnClaudeCodeProcess: () =>
      Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        exitCode: null,
        kill: vi.fn(),
      }),
  };
}
export async function sdkFixtureHistory(sessionId: string, options?: { dir?: string }) {
  return { sessionId, cwd: options?.dir };
}

/** Echo the submitted wire identity as the replay-user-messages protocol does. */
export function sdkInputReplay(input: { uuid?: unknown; message: unknown }, sessionId: string) {
  if (typeof input.uuid !== 'string') throw Error('Fixture received SDK input without a UUID');
  return {
    type: 'user',
    uuid: input.uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: input.message,
    isReplay: true,
  };
}

export function sdkQueryPeer(
  request: Parameters<typeof query>[0],
  events: AsyncGenerator<unknown>,
): Query {
  if (!request.options?.spawnClaudeCodeProcess)
    throw Error('Offline SDK process boundary required');
  const child = request.options.spawnClaudeCodeProcess({
    command: 'offline-sdk-fixture',
    args: [],
    env: {},
    signal: request.options.abortController?.signal ?? new AbortController().signal,
  }) as unknown as EventEmitter;
  return Object.assign(events, {
    close: vi.fn(() => child.emit('close', 0, null)),
  }) as unknown as Query;
}
