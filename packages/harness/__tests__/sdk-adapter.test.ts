import { describe, it, expect, vi } from 'vitest';
import type {
  ModelSession,
  StreamEvent,
  ConversationMessage,
  ContentBlock,
} from '../src/providers/session-types.js';
import {
  sdkWrapperEmitter,
  runAgenticLoop,
  type AgenticLoopOptions,
} from '../src/providers/sdk-adapter.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Build a mock ModelSession that yields canned events per turn. */
function mockSession(turnsEvents: StreamEvent[][]): ModelSession {
  let turnIndex = 0;
  return {
    provider: 'test',
    async *turn(_messages: ConversationMessage[]): AsyncIterable<StreamEvent> {
      const events = turnsEvents[turnIndex] ?? [];
      turnIndex++;
      for (const evt of events) {
        yield evt;
      }
    },
  };
}

/** A minimal text-only turn: message_start → block_start → delta → block_stop → message_delta. */
function textTurnEvents(text: string, messageId = 'msg-1'): StreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: messageId,
        model: 'test',
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 10 },
    },
  ];
}

/** A turn that ends with tool_use: message_start → tool block → message_delta(tool_use). */
function toolUseTurnEvents(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>,
  messageId = 'msg-tool',
): StreamEvent[] {
  const inputJson = JSON.stringify(input);
  return [
    {
      type: 'message_start',
      message: {
        id: messageId,
        model: 'test',
        role: 'assistant',
        usage: { input_tokens: 200, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 20 },
    },
  ];
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

// ── sdkWrapperEmitter ───────────────────────────────────────────

describe('sdkWrapperEmitter', () => {
  it('wraps a text turn into stream_event wrappers then assistant wrapper', async () => {
    const session = mockSession([textTurnEvents('hello')]);
    const messages: ConversationMessage[] = [{ role: 'user', content: 'hi' }];

    const events = await collect(
      sdkWrapperEmitter(session, messages, { sessionId: 'sid-1', startMs: Date.now() }),
    );

    // Should have 5 stream_event wrappers + 1 assistant wrapper = 6 total
    const streamEvents = events.filter((e) => e.type === 'stream_event');
    const assistantEvents = events.filter((e) => e.type === 'assistant');
    expect(streamEvents).toHaveLength(5);
    expect(assistantEvents).toHaveLength(1);

    // Assistant wrapper carries session_id and content blocks
    const assistant = assistantEvents[0];
    expect(assistant.session_id).toBe('sid-1');
    expect(assistant.parent_tool_use_id).toBeNull();
  });

  it('wraps a tool_use turn and extracts tool blocks', async () => {
    const session = mockSession([toolUseTurnEvents('Read', 'tool-1', { file_path: '/foo' })]);
    const messages: ConversationMessage[] = [{ role: 'user', content: 'read file' }];

    const events = await collect(
      sdkWrapperEmitter(session, messages, { sessionId: 'sid-2', startMs: Date.now() }),
    );

    const assistant = events.find((e) => e.type === 'assistant')!;
    expect(assistant).toBeDefined();
    // The assistant message should contain content blocks including the tool_use
    const content = (assistant as { message: { content: ContentBlock[] } }).message.content;
    const toolBlocks = content.filter((b) => b.type === 'tool_use');
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
    });
  });

  it('accumulates usage from message_start and message_delta', async () => {
    const session = mockSession([textTurnEvents('hello')]);
    const messages: ConversationMessage[] = [{ role: 'user', content: 'hi' }];

    const events = await collect(
      sdkWrapperEmitter(session, messages, { sessionId: 'sid-3', startMs: Date.now() }),
    );

    const assistant = events.find((e) => e.type === 'assistant')!;
    const usage = (assistant as Record<string, unknown>).usage as Record<string, number>;
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(10);
  });
});

// ── runAgenticLoop ──────────────────────────────────────────────

describe('runAgenticLoop', () => {
  it('completes immediately when model produces no tool_use', async () => {
    const session = mockSession([textTurnEvents('done')]);
    const opts: AgenticLoopOptions = {
      sessionId: 'loop-1',
      maxTurns: 10,
      executeTool: vi.fn(),
    };

    const events = await collect(runAgenticLoop(session, [{ role: 'user', content: 'hi' }], opts));

    // Should have stream_events + assistant + result
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents).toHaveLength(1);
    expect((resultEvents[0] as Record<string, unknown>).num_turns).toBe(1);

    // executeTool should never have been called
    expect(opts.executeTool).not.toHaveBeenCalled();
  });

  it('loops when model uses tools, then stops when no more tools', async () => {
    // Turn 1: tool_use → Turn 2: text (done)
    const session = mockSession([
      toolUseTurnEvents('Read', 'tool-1', { file_path: '/foo' }),
      textTurnEvents('file contents here', 'msg-2'),
    ]);

    const executeTool = vi.fn().mockResolvedValue({
      type: 'tool_result' as const,
      tool_use_id: 'tool-1',
      content: 'file data',
    });

    const opts: AgenticLoopOptions = {
      sessionId: 'loop-2',
      maxTurns: 10,
      executeTool,
    };

    const events = await collect(
      runAgenticLoop(session, [{ role: 'user', content: 'read' }], opts),
    );

    // executeTool called once for 'Read'
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Read', id: 'tool-1' }),
    );

    // Two assistant events (one per turn)
    const assistantEvents = events.filter((e) => e.type === 'assistant');
    expect(assistantEvents).toHaveLength(2);

    // One user event (tool result passed back)
    const userEvents = events.filter((e) => e.type === 'user');
    expect(userEvents).toHaveLength(1);

    // Result event with 2 turns
    const result = events.find((e) => e.type === 'result')!;
    expect((result as Record<string, unknown>).num_turns).toBe(2);
  });

  it('handles multiple tool calls in a single turn', async () => {
    // Turn 1: two tool_use blocks → Turn 2: text
    const multiToolEvents: StreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg-multi',
          model: 'test',
          role: 'assistant',
          usage: { input_tokens: 300, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-a', name: 'Read', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-b', name: 'Grep', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"pattern":"foo"}' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 30 },
      },
    ];

    const session = mockSession([multiToolEvents, textTurnEvents('results', 'msg-final')]);

    const executeTool = vi.fn().mockImplementation(async (block: { id: string; name: string }) => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: `result for ${block.name}`,
    }));

    const opts: AgenticLoopOptions = {
      sessionId: 'loop-3',
      maxTurns: 10,
      executeTool,
    };

    const events = await collect(
      runAgenticLoop(session, [{ role: 'user', content: 'search' }], opts),
    );

    // Both tools executed
    expect(executeTool).toHaveBeenCalledTimes(2);

    // Two user events (one per tool result)
    const userEvents = events.filter((e) => e.type === 'user');
    expect(userEvents).toHaveLength(2);
  });

  it('respects maxTurns limit', async () => {
    // Session that always returns tool_use — should stop after maxTurns
    const infiniteToolSession: ModelSession = {
      provider: 'test',
      async *turn(): AsyncIterable<StreamEvent> {
        yield* toolUseTurnEvents('Read', `tool-${Date.now()}`, { file_path: '/loop' });
      },
    };

    const executeTool = vi.fn().mockResolvedValue({
      type: 'tool_result' as const,
      tool_use_id: 'any',
      content: 'ok',
    });

    const opts: AgenticLoopOptions = {
      sessionId: 'loop-max',
      maxTurns: 3,
      executeTool,
    };

    const events = await collect(
      runAgenticLoop(infiniteToolSession, [{ role: 'user', content: 'go' }], opts),
    );

    const result = events.find((e) => e.type === 'result')!;
    expect((result as Record<string, unknown>).num_turns).toBe(3);
  });

  it('stops on abort signal', async () => {
    const controller = new AbortController();
    let turnCount = 0;

    const session: ModelSession = {
      provider: 'test',
      async *turn(): AsyncIterable<StreamEvent> {
        turnCount++;
        if (turnCount >= 2) controller.abort();
        yield* toolUseTurnEvents('Read', `tool-${turnCount}`, { file_path: '/x' });
      },
    };

    const executeTool = vi.fn().mockResolvedValue({
      type: 'tool_result' as const,
      tool_use_id: 'any',
      content: 'ok',
    });

    const opts: AgenticLoopOptions = {
      sessionId: 'loop-abort',
      maxTurns: 100,
      signal: controller.signal,
      executeTool,
    };

    const events = await collect(runAgenticLoop(session, [{ role: 'user', content: 'go' }], opts));

    // Should have stopped — result emitted with turns <= 2
    const result = events.find((e) => e.type === 'result')!;
    expect((result as Record<string, unknown>).num_turns).toBeLessThanOrEqual(2);
  });

  it('accumulates usage across turns in the result event', async () => {
    const session = mockSession([
      toolUseTurnEvents('Read', 'tool-1', { file_path: '/a' }),
      textTurnEvents('done', 'msg-2'),
    ]);

    const executeTool = vi.fn().mockResolvedValue({
      type: 'tool_result' as const,
      tool_use_id: 'tool-1',
      content: 'data',
    });

    const opts: AgenticLoopOptions = {
      sessionId: 'loop-usage',
      maxTurns: 10,
      executeTool,
    };

    const events = await collect(runAgenticLoop(session, [{ role: 'user', content: 'go' }], opts));
    const result = events.find((e) => e.type === 'result')!;
    const usage = (result as Record<string, unknown>).usage as Record<string, number>;

    // Turn 1: input=200, output=20. Turn 2: input=100, output=10.
    // Input tokens are context (latest value), output tokens accumulate.
    expect(usage.input_tokens).toBe(100); // latest turn's input
    expect(usage.output_tokens).toBe(30); // 20 + 10
  });
});
