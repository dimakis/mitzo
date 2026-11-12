import { expect, it, vi } from 'vitest';
import { runScopedAdviser } from '../adviser-harness-runtime.js';
import { AdviserTaskScope } from '../adviser-task-scope.js';
const makeScope = (signal = new AbortController().signal, publication = false) => {
  const scope = new AdviserTaskScope(
    {
      authSessionId: 'operator',
      feature: publication
        ? { kind: 'github-publication', operationId: 'publication' }
        : { kind: 'terminal', terminalId: 'term' },
      accountId: 'work',
      model: 'gpt-6-luna',
      instructions: 'Explain',
      messages: [{ role: 'user', content: 'Reviewed' }],
    },
    () => {},
    signal,
  );
  scope.bindCommand('task', 'command');
  return scope;
};
type Observation = Parameters<Parameters<typeof runScopedAdviser>[1]>[0];
const text = (owner: Observation, value: string, messageId = 'reply') => {
  owner.onQueryEvent({ type: 'message_start', sessionId: 'task', messageId });
  owner.onQueryEvent({
    type: 'block_start',
    sessionId: 'task',
    messageId,
    blockId: 'b0',
    blockType: 'text',
  });
  owner.onQueryEvent({
    type: 'block_delta',
    sessionId: 'task',
    messageId,
    blockId: 'b0',
    blockType: 'text',
    delta: value,
  });
};
it('projects real query-loop text block events, requires a provider result and awaits owner cleanup', async () => {
  let cleaned = false;
  const close = vi.fn(async () => {
    await Promise.resolve();
    cleaned = true;
  });
  const dispatch = vi.fn(async (owner: Observation) => {
    text(owner, 'hello');
    owner.onQueryEvent({ type: 'session_end', sessionId: 'task' });
    return { close };
  });
  await expect(runScopedAdviser(makeScope(), dispatch)).resolves.toEqual({ text: 'hello' });
  expect(cleaned).toBe(true);
});
it('projects the final publication message without progress prose while bounding every text byte', async () => {
  const scope = makeScope(new AbortController().signal, true);
  const close = vi.fn();
  await expect(
    runScopedAdviser(scope, async (owner) => {
      text(owner, 'I am tracing the changed contract.', 'progress');
      text(owner, '{"verdict":', 'final');
      owner.onQueryEvent({
        type: 'block_delta',
        sessionId: 'task',
        messageId: 'final',
        blockId: 'b0',
        blockType: 'text',
        delta: '"context_required"}',
      });
      owner.onQueryEvent({ type: 'session_end', sessionId: 'task' });
      return { close };
    }),
  ).resolves.toEqual({ text: '{"verdict":"context_required"}' });
  expect(close).toHaveBeenCalledOnce();
  await expect(
    runScopedAdviser(makeScope(new AbortController().signal, true), async (owner) => {
      text(owner, 'x'.repeat(20000), 'progress');
      text(owner, 'y'.repeat(20000), 'final');
      return { close };
    }),
  ).rejects.toThrow('limit');
});
it('refuses foreign session output, failed/missing terminal, cancellation and oversized text without redispatch', async () => {
  const close = vi.fn(async () => {});
  await expect(
    runScopedAdviser(makeScope(), async (owner) => {
      owner.onQueryEvent({
        type: 'block_delta',
        sessionId: 'unrelated',
        messageId: 'reply',
        blockId: 'b0',
        blockType: 'text',
        delta: 'secret',
      });
      owner.onTerminalOutcome();
      return { close };
    }),
  ).rejects.toThrow(/identity|session/i);
  await expect(
    runScopedAdviser(makeScope(), async (owner) => {
      text(owner, 'partial');
      owner.onTerminalOutcome();
      return { close };
    }),
  ).rejects.toThrow(/terminal/i);
  await expect(
    runScopedAdviser(makeScope(), async (owner) => {
      text(owner, 'partial');
      owner.onQueryEvent({ type: 'session_end', sessionId: 'task', terminalReason: 'failed' });
      return { close };
    }),
  ).rejects.toThrow();
  const controller = new AbortController();
  const dispatch = vi.fn(async (owner: Observation) => {
    text(owner, 'late');
    controller.abort();
    return { close };
  });
  await expect(runScopedAdviser(makeScope(controller.signal), dispatch)).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledOnce();
  await expect(
    runScopedAdviser(makeScope(), async (owner) => {
      text(owner, 'x'.repeat(32769));
      return { close };
    }),
  ).rejects.toThrow('limit');
});

it('preserves real cache usage without inventing absent counts', async () => {
  const result = await runScopedAdviser(makeScope(), async (owner) => {
    text(owner, 'actual');
    owner.onQueryEvent({
      type: 'session_end',
      sessionId: 'task',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 50, cacheCreationTokens: 20 },
    });
    return { close() {} };
  });
  expect(result.usage).toEqual({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 50,
    cacheCreationTokens: 20,
  });
});
