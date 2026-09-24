import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionTransport } from '@mitzo/harness';
import { runQueryLoop } from '../query-loop.js';
import { CodexSessionEvents } from '../codex-session-events.js';
import type { SessionRegistry } from '../session-registry.js';

/** Create a fake SessionTransport that records sent messages */
function fakeTransport(): SessionTransport & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    send: vi.fn((data: Record<string, unknown>) => sent.push(data)),
    isOpen: () => true,
    sent,
  } as unknown as SessionTransport & { sent: Record<string, unknown>[] };
}

/** Create a minimal SessionRegistry stub */
function fakeRegistry(transport: SessionTransport): SessionRegistry {
  let removed = false;
  const session = {
    transport,
    sessionId: undefined as string | undefined,
    currentSnapshot: null as null | { messageId: string; blocks: unknown[] },
    observers: new Set<SessionTransport>(),
    cumulativeSessionTokens: 0,
    cumulativeCostUsd: 0,
  };
  return {
    get: vi.fn(() => (removed ? null : session)),
    setSessionId: vi.fn((_, id: string) => {
      session.sessionId = id;
    }),
    remove: vi.fn(() => {
      removed = true;
    }),
    setMode: vi.fn(),
    isAttached: vi.fn(() => true),
    isSuspended: vi.fn(() => false),
    bufferEvent: vi.fn(() => false),
  } as unknown as SessionRegistry;
}

async function* eventStream(events: Record<string, unknown>[]) {
  for (const e of events) yield e;
}

describe('token_update emission', () => {
  let transport: SessionTransport & { sent: Record<string, unknown>[] };
  let registry: SessionRegistry;
  const clientId = 'test-client';
  let abortController: AbortController;

  beforeEach(() => {
    transport = fakeTransport();
    registry = fakeRegistry(transport);
    abortController = new AbortController();
  });

  it('sums input + cached tokens for agent context from message_start', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: {
            id: 'msg-tok',
            usage: {
              input_tokens: 1,
              cache_read_input_tokens: 80000,
              cache_creation_input_tokens: 7203,
            },
          },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-tok' },
      {
        type: 'result',
        session_id: 'sess-tok',
        usage: {
          input_tokens: 1,
          output_tokens: 500,
          cache_read_input_tokens: 80000,
          cache_creation_input_tokens: 7203,
        },
        total_cost_usd: 0.05,
        num_turns: 1,
        duration_ms: 5000,
        duration_api_ms: 3000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const tokenUpdates = transport.sent.filter((m) => m.type === 'token_update');
    expect(tokenUpdates.length).toBeGreaterThanOrEqual(1);

    // Agent context should be sum of input + cache_read + cache_creation
    const first = tokenUpdates[0];
    expect(first).toMatchObject({
      agentContext: 87204, // 1 + 80000 + 7203
      contextCeiling: 200_000,
    });
  });

  it('includes all token types in session total', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-st', usage: { input_tokens: 5000 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-st' },
      {
        type: 'result',
        session_id: 'sess-st',
        usage: {
          input_tokens: 5000,
          output_tokens: 2000,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 3000,
        },
        total_cost_usd: 0.03,
        num_turns: 1,
        duration_ms: 8000,
        duration_api_ms: 5000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const tokenUpdates = transport.sent.filter((m) => m.type === 'token_update');
    const last = tokenUpdates[tokenUpdates.length - 1];
    expect(last).toMatchObject({
      sessionTotal: 20000, // 5000 + 2000 + 10000 + 3000
      contextCeiling: 200_000,
    });
    // costUsd should not be present
    expect(last).not.toHaveProperty('costUsd');
  });

  it('shows OpenAI usage reported at response completion', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: {
            id: 'msg-openai',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 1200, output_tokens: 300 },
        },
      },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-openai' },
      {
        type: 'result',
        session_id: 'sess-openai',
        usage: { input_tokens: 1200, output_tokens: 300 },
        num_turns: 1,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const tokenUpdates = transport.sent.filter((message) => message.type === 'token_update');
    expect(tokenUpdates).toContainEqual(
      expect.objectContaining({ agentContext: 1200, turnIndex: 1 }),
    );
    expect(tokenUpdates.at(-1)).toMatchObject({
      agentContext: 1200,
      sessionTotal: 1500,
      turnIndex: 1,
    });
  });

  it('counts a Codex provider turn once across reasoning, text, and tool blocks', async () => {
    const events: Record<string, unknown>[] = [];
    const mapper = new CodexSessionEvents('sess-codex', 'thread-codex', 'model', (event) =>
      events.push(event),
    );
    mapper.notification('turn/started', {
      threadId: 'thread-codex',
      turn: { id: 'turn-1' },
    });
    mapper.notification('item/reasoning/summaryTextDelta', {
      threadId: 'thread-codex',
      itemId: 'reasoning-1',
      summaryIndex: 0,
      delta: 'Thinking',
    });
    mapper.notification('item/agentMessage/delta', {
      threadId: 'thread-codex',
      itemId: 'message-1',
      delta: 'Answer',
    });
    mapper.toolStart('provider-tool-1', 'Read', { file_path: 'README.md' });
    mapper.notification('turn/completed', {
      threadId: 'thread-codex',
      turn: { id: 'turn-1', status: 'completed' },
    });

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    expect(events.filter((event) => event.type === 'provider_turn_start')).toHaveLength(1);
    expect(
      events.filter(
        (event) => (event.event as { type?: string } | undefined)?.type === 'message_start',
      ),
    ).toHaveLength(3);
    expect(
      transport.sent.filter((message) => message.type === 'token_update').at(-1),
    ).toMatchObject({
      turnIndex: 1,
      numTurns: 1,
    });
  });

  it('ignores sub-agent message_start for agent context', async () => {
    const events: Record<string, unknown>[] = [
      // Parent message_start
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: {
            id: 'msg-parent',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 50000,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-sub' },
      // Sub-agent message_start (should NOT overwrite parent context)
      {
        type: 'stream_event',
        parent_tool_use_id: 'tool-123',
        event: {
          type: 'message_start',
          message: {
            id: 'msg-sub',
            usage: { input_tokens: 1, cache_read_input_tokens: 2000 },
          },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-sub' },
      {
        type: 'result',
        session_id: 'sess-sub',
        usage: { input_tokens: 5000, output_tokens: 1000 },
        total_cost_usd: 0.02,
        num_turns: 2,
        duration_ms: 6000,
        duration_api_ms: 4000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const tokenUpdates = transport.sent.filter((m) => m.type === 'token_update');

    // Only one token_update from message_start (the parent one)
    const messageStartUpdates = tokenUpdates.filter(
      (m) => (m as Record<string, unknown>).sessionTotal === undefined,
    );
    expect(messageStartUpdates).toHaveLength(1);
    expect(messageStartUpdates[0]).toMatchObject({
      agentContext: 50100, // 100 + 50000 + 0
      turnIndex: 1,
    });

    // Final token_update should preserve the parent agentContext
    const last = tokenUpdates[tokenUpdates.length - 1];
    expect(last).toMatchObject({
      agentContext: 50100, // NOT overwritten by sub-agent
    });
  });

  it('tracks turnIndex only for parent message_starts', async () => {
    const events: Record<string, unknown>[] = [
      // Parent turn 1
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-t1', usage: { input_tokens: 3000 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-ai' },
      // Sub-agent turn (should NOT increment turnIndex)
      {
        type: 'stream_event',
        parent_tool_use_id: 'tool-456',
        event: {
          type: 'message_start',
          message: { id: 'msg-sub', usage: { input_tokens: 500 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-ai' },
      // Parent turn 2
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-t2', usage: { input_tokens: 8000 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-ai' },
      {
        type: 'result',
        session_id: 'sess-ai',
        usage: { input_tokens: 8000, output_tokens: 3000 },
        total_cost_usd: 0.06,
        num_turns: 2,
        duration_ms: 12000,
        duration_api_ms: 9000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const tokenUpdates = transport.sent.filter((m) => m.type === 'token_update');
    // Only parent message_starts should emit token_update with turnIndex
    const messageStartUpdates = tokenUpdates.filter(
      (m) => (m as Record<string, unknown>).sessionTotal === undefined,
    );
    expect(messageStartUpdates).toHaveLength(2);
    expect(messageStartUpdates[0]).toMatchObject({ turnIndex: 1 });
    expect(messageStartUpdates[1]).toMatchObject({ turnIndex: 2 });
  });

  it('does not double-count session total across multiple result events', async () => {
    // SDK reports cumulative totals — each result includes ALL prior usage.
    // The session total should reflect the SDK's cumulative value, not sum them.
    const events: Record<string, unknown>[] = [
      // Turn 1
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-t1', usage: { input_tokens: 5000 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-multi' },
      {
        type: 'result',
        session_id: 'sess-multi',
        usage: { input_tokens: 5000, output_tokens: 1000 },
        total_cost_usd: 0.02,
        num_turns: 1,
        duration_ms: 3000,
        duration_api_ms: 2000,
      },
      // Turn 2 — SDK reports cumulative: 12000 input (not 7000 delta)
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-t2', usage: { input_tokens: 12000 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-multi' },
      {
        type: 'result',
        session_id: 'sess-multi',
        usage: { input_tokens: 12000, output_tokens: 3000 },
        total_cost_usd: 0.05,
        num_turns: 2,
        duration_ms: 8000,
        duration_api_ms: 6000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const tokenUpdates = transport.sent.filter((m) => m.type === 'token_update');
    const resultUpdates = tokenUpdates.filter(
      (m) => (m as Record<string, unknown>).sessionTotal !== undefined,
    );

    // Should have two result-based token_updates
    expect(resultUpdates).toHaveLength(2);
    // Turn 1: 5000 + 1000 = 6000
    expect(resultUpdates[0]).toMatchObject({ sessionTotal: 6000 });
    // Turn 2: 12000 + 3000 = 15000 (NOT 6000 + 15000 = 21000)
    expect(resultUpdates[1]).toMatchObject({ sessionTotal: 15000 });
  });

  it('counts compaction events from SDK system messages', async () => {
    const events: Record<string, unknown>[] = [
      // Parent message_start
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-c1', usage: { input_tokens: 180000 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-compact' },
      // SDK system status: compaction completed
      {
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'success',
        session_id: 'sess-compact',
      },
      // Next turn after compaction — context dropped
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-c2', usage: { input_tokens: 40000 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-compact' },
      {
        type: 'result',
        session_id: 'sess-compact',
        usage: { input_tokens: 40000, output_tokens: 1000 },
        total_cost_usd: 0.02,
        num_turns: 2,
        duration_ms: 5000,
        duration_api_ms: 3000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const tokenUpdates = transport.sent.filter((m) => m.type === 'token_update');
    // The final token_update should include numCompactions: 1
    const last = tokenUpdates[tokenUpdates.length - 1];
    expect(last).toMatchObject({ numCompactions: 1 });
  });

  it('handles missing usage on message_start gracefully', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'msg-no-usage' },
          // No usage field
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-nu' },
      { type: 'result', session_id: 'sess-nu' },
    ];

    // Should not throw
    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    // token_update may or may not be emitted, but should not crash
    const errors = transport.sent.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(0);
  });
});
