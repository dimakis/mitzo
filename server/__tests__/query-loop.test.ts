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
  const session = { ws, sessionId: undefined as string | undefined };
  return {
    get: vi.fn(() => session),
    setSessionId: vi.fn((_, id: string) => {
      session.sessionId = id;
    }),
    remove: vi.fn(),
    setMode: vi.fn(),
  } as unknown as SessionRegistry;
}

/** Build an async iterable from an array of SDK events */
async function* eventStream(events: Record<string, unknown>[]) {
  for (const e of events) yield e;
}

describe('runQueryLoop', () => {
  let ws: WebSocket & { sent: Record<string, unknown>[] };
  let registry: SessionRegistry;
  const clientId = 'test-client';
  let abortController: AbortController;

  beforeEach(() => {
    ws = fakeWs();
    registry = fakeRegistry(ws);
    abortController = new AbortController();
  });

  it('does not re-send text blocks from assistant event (prevents duplicates)', async () => {
    // Simulate: text streamed via content_block_delta, then assistant event fires
    // with the complete message containing the same text block.
    // The assistant event should NOT re-send the text.
    const events: Record<string, unknown>[] = [
      // Stream: content_block_start (text)
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      // Stream: text delta
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello world' },
        },
      },
      // Stream: content_block_stop
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      // Assistant event with complete message (text already streamed)
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
        session_id: 'sess-1',
      },
      // Result
      { type: 'result', session_id: 'sess-1' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const textMessages = ws.sent.filter((m: Record<string, unknown>) => m.type === 'text');
    const textDeltaMessages = ws.sent.filter(
      (m: Record<string, unknown>) => m.type === 'text_delta',
    );

    // text_delta should be sent (streaming)
    expect(textDeltaMessages).toHaveLength(1);
    expect(textDeltaMessages[0]).toEqual({ type: 'text_delta', text: 'Hello world' });

    // text (finalization) should NOT be sent from assistant event
    expect(textMessages).toHaveLength(0);
  });

  it('does not duplicate text when tool calls interleave', async () => {
    // This is the critical bug scenario:
    // 1. Text streams via text_delta
    // 2. Tool call happens
    // 3. Assistant event fires with text block → should NOT create duplicate
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start' } },
      // Text block
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Checking...' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      // Tool use block
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', name: 'Bash', id: 'tool-1' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      // Assistant event with both text and tool_use in content
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Checking...' },
            { type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'echo hi' } },
          ],
        },
        session_id: 'sess-2',
      },
      // Tool result comes back
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hi\n' }],
        },
      },
      { type: 'result', session_id: 'sess-2' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const textDeltaMessages = ws.sent.filter(
      (m: Record<string, unknown>) => m.type === 'text_delta',
    );
    const textMessages = ws.sent.filter((m: Record<string, unknown>) => m.type === 'text');
    const toolCallMessages = ws.sent.filter((m: Record<string, unknown>) => m.type === 'tool_call');

    // text_delta: streamed once
    expect(textDeltaMessages).toHaveLength(1);

    // text: should NOT appear (no duplicate from assistant event)
    expect(textMessages).toHaveLength(0);

    // tool_call: sent once from content_block_stop
    expect(toolCallMessages).toHaveLength(1);
    expect(toolCallMessages[0]).toMatchObject({ toolName: 'Bash', toolId: 'tool-1' });
  });

  it('still sends thinking events correctly', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think...' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'The answer is 42' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think...' },
            { type: 'text', text: 'The answer is 42' },
          ],
        },
        session_id: 'sess-3',
      },
      { type: 'result', session_id: 'sess-3' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const thinkingStart = ws.sent.filter(
      (m: Record<string, unknown>) => m.type === 'thinking_start',
    );
    const thinkingDelta = ws.sent.filter(
      (m: Record<string, unknown>) => m.type === 'thinking_delta',
    );
    const textDelta = ws.sent.filter((m: Record<string, unknown>) => m.type === 'text_delta');
    const textMessages = ws.sent.filter((m: Record<string, unknown>) => m.type === 'text');

    expect(thinkingStart).toHaveLength(1);
    expect(thinkingDelta).toHaveLength(1);
    expect(textDelta).toHaveLength(1);
    // No duplicate text from assistant event
    expect(textMessages).toHaveLength(0);
  });

  it('sends session_id from assistant event and result event', async () => {
    const events: Record<string, unknown>[] = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
        session_id: 'sess-new',
      },
      { type: 'result', session_id: 'sess-new' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    expect(registry.setSessionId).toHaveBeenCalledWith(clientId, 'sess-new');
    // assistant sends session_id (first time), result also sends session_id
    const sessionIdMsgs = ws.sent.filter((m: Record<string, unknown>) => m.type === 'session_id');
    expect(sessionIdMsgs).toHaveLength(2);
  });
});
