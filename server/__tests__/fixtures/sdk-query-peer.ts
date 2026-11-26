import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, vi } from 'vitest';
import type { Options, Query, query } from '@anthropic-ai/claude-agent-sdk';

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

/** Drive the captured PreToolUse matchers for one call as the SDK CLI selects them. */
export async function sdkPreToolUse(
  options: Options,
  toolName: string,
  toolInput: Record<string, unknown>,
) {
  const signal = new AbortController().signal;
  const results: unknown[] = [];
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    if (matcher.matcher && !new RegExp(matcher.matcher).test(toolName)) continue;
    for (const hook of matcher.hooks)
      results.push(
        await hook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: toolName,
            tool_input: toolInput,
            tool_use_id: `${toolName}-gate`,
            session_id: 'offline-permission-gate',
            transcript_path: '',
            cwd: options.cwd ?? '',
          },
          `${toolName}-gate`,
          { signal },
        ),
      );
  }
  return results;
}

/**
 * Bare allowedTools entries make the SDK skip canUseTool, so the matcher-less
 * PreToolUse hook is the only gate for them. Call with the session in Ask mode.
 */
export async function expectAskModeSdkPermissionGate(options: Options) {
  expect(options.canUseTool).toBeTypeOf('function');
  for (const name of [
    'mcp__mitzo-connections__SaveKnowledgeDraft',
    'mcp__mitzo-connections__ReadKnowledge',
  ])
    expect(
      options.allowedTools!.some((entry) =>
        new RegExp(`^${entry.replaceAll('*', '.*')}$`).test(name),
      ),
    ).toBe(true);
  expect(options.hooks?.PreToolUse?.some((matcher) => matcher.matcher === undefined)).toBe(true);
  // The same invariant allows startGatedSdkQuery to drop the SDK's false-positive warning.
  const { hasSessionPermissionGate } = await import('../../session-permission-policy.js');
  expect(hasSessionPermissionGate(options.hooks)).toBe(true);
  const decision = (results: unknown[]) =>
    results.find((result) =>
      ['deny', 'allow'].includes(
        (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
          ?.permissionDecision ?? '',
      ),
    );
  // A read under the same bare entry passes, so the denial below is Ask policy.
  expect(
    decision(
      await sdkPreToolUse(options, 'mcp__mitzo-connections__ReadKnowledge', { action: 'list' }),
    ),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  expect(
    decision(
      await sdkPreToolUse(options, 'mcp__mitzo-connections__SaveKnowledgeDraft', {
        requestId: '5f1e8a52-8c0f-4d55-9a49-0d6c3c1f7a10',
        title: 'Ask mode proposal',
        baseRevision: 'a'.repeat(40),
        documents: [{ path: 'memory/Observations/lesson.md', content: 'Proposed' }],
      }),
    ),
  ).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: 'Ask mode only permits connection reads',
    },
  });
}
