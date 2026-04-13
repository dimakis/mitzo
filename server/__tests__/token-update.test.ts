import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import { runQueryLoop } from '../query-loop.js';
import type { SessionRegistry } from '../session-registry.js';

/** Create a fake WebSocket that records sent messages */
function fakeWs(): WebSocket & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    sent,
  } as unknown as WebSocket & { sent: Record<string, unknown>[] };
}

/** Create a minimal SessionRegistry stub */
function fakeRegistry(ws: WebSocket): SessionRegistry {
  let removed = false;
  const session = {
    ws,
    sessionId: undefined as string | undefined,
    currentSnapshot: null as null | { messageId: string; blocks: unknown[] },
    observers: new Set<WebSocket>(),
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
  } as unknown as SessionRegistry;
}

async function* eventStream(events: Record<string, unknown>[]) {
  for (const e of events) yield e;
}

describe('token_update emission', () => {
  let ws: WebSocket & { sent: Record<string, unknown>[] };
  let registry: SessionRegistry;
  const clientId = 'test-client';
  let abortController: AbortController;

  beforeEach(() => {
    ws = fakeWs();
    registry = fakeRegistry(ws);
    abortController = new AbortController();
  });

  it('emits token_update with agent context from message_start usage', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: 'msg-tok',
            usage: { input_tokens: 87204, output_tokens: 0 },
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
        usage: { input_tokens: 87204, output_tokens: 500 },
        total_cost_usd: 0.05,
        num_turns: 1,
        duration_ms: 5000,
        duration_api_ms: 3000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const tokenUpdates = ws.sent.filter((m) => m.type === 'token_update');
    expect(tokenUpdates.length).toBeGreaterThanOrEqual(1);

    // The first token_update should have agent context from message_start
    const first = tokenUpdates[0];
    expect(first).toMatchObject({
      agentContext: 87204,
      contextCeiling: 200_000,
    });
  });

  it('emits token_update with session totals on result', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
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
        usage: { input_tokens: 5000, output_tokens: 2000 },
        total_cost_usd: 0.03,
        num_turns: 1,
        duration_ms: 8000,
        duration_api_ms: 5000,
      },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const tokenUpdates = ws.sent.filter((m) => m.type === 'token_update');
    // Should have at least a final token_update with session totals
    const last = tokenUpdates[tokenUpdates.length - 1];
    expect(last).toMatchObject({
      sessionTotal: 7000, // input + output
      costUsd: 0.03,
      contextCeiling: 200_000,
    });
  });

  it('includes agentIndex tracking across turns', async () => {
    const events: Record<string, unknown>[] = [
      // Turn 1
      {
        type: 'stream_event',
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
      // Turn 2 (tool result triggers another turn)
      {
        type: 'stream_event',
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

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const tokenUpdates = ws.sent.filter((m) => m.type === 'token_update');
    expect(tokenUpdates.length).toBeGreaterThanOrEqual(2);

    // Second message_start should show updated agent context
    const second = tokenUpdates.find((m) => m.agentContext === 8000);
    expect(second).toBeDefined();
  });

  it('handles missing usage on message_start gracefully', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
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
    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    // token_update may or may not be emitted, but should not crash
    const errors = ws.sent.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(0);
  });
});
