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

/** Create a minimal SessionRegistry stub with currentSnapshot support */
function fakeRegistry(ws: WebSocket): SessionRegistry {
  let removed = false;
  const session = {
    ws,
    sessionId: undefined as string | undefined,
    currentSnapshot: null as null | { messageId: string; blocks: unknown[] },
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
  } as unknown as SessionRegistry;
}

/** Build an async iterable from an array of SDK events */
async function* eventStream(events: Record<string, unknown>[]) {
  for (const e of events) yield e;
}

/** Helper: v2 message matcher (ignores ts) */
function v2msg(type: string, rest: Record<string, unknown> = {}) {
  return expect.objectContaining({ v: 2, type, ...rest });
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

  it('emits message_start, block_start, block_delta, block_end, message_end, session_end for a text turn', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-abc' } } },
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
      { type: 'assistant', message: { content: [] }, session_id: 'sess-1' },
      { type: 'result', session_id: 'sess-1' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const sent = ws.sent;
    expect(sent).toEqual(
      expect.arrayContaining([
        v2msg('message_start', { messageId: 'msg-abc' }),
        v2msg('block_start', { messageId: 'msg-abc', blockType: 'text' }),
        v2msg('block_delta', { blockType: 'text', delta: 'Hello' }),
        v2msg('block_end', { blockType: 'text' }),
        v2msg('message_end', { messageId: 'msg-abc' }),
        v2msg('session_end', { sessionId: 'sess-1' }),
      ]),
    );
  });

  it('emits block_start+block_delta+block_end for thinking blocks', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-th' } } },
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
      { type: 'assistant', message: { content: [] }, session_id: 'sess-th' },
      { type: 'result', session_id: 'sess-th' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const sent = ws.sent;
    expect(sent).toEqual(
      expect.arrayContaining([
        v2msg('block_start', { blockType: 'thinking' }),
        v2msg('block_delta', { blockType: 'thinking', delta: 'Let me think...' }),
        v2msg('block_end', { blockType: 'thinking' }),
        v2msg('block_start', { blockType: 'text' }),
        v2msg('block_delta', { blockType: 'text', delta: 'The answer is 42' }),
        v2msg('block_end', { blockType: 'text' }),
      ]),
    );

    // No old-style events
    expect(sent.some((m) => m.type === 'thinking_start')).toBe(false);
    expect(sent.some((m) => m.type === 'thinking_delta')).toBe(false);
    expect(sent.some((m) => m.type === 'text_delta')).toBe(false);
  });

  it('emits block_end with toolName/toolId/input for tool_use blocks', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-tool' } } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', name: 'Bash', id: 'tool-1' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-tool' },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hi\n' }] },
      },
      { type: 'result', session_id: 'sess-tool' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const sent = ws.sent;

    const blockStart = sent.find((m) => m.type === 'block_start' && m.blockType === 'tool_use');
    expect(blockStart).toBeDefined();
    expect(blockStart).toMatchObject({ toolName: 'Bash' });

    const blockEnd = sent.find((m) => m.type === 'block_end' && m.blockType === 'tool_use');
    expect(blockEnd).toBeDefined();
    expect(blockEnd).toMatchObject({ toolName: 'Bash', toolId: 'tool-1' });

    const toolResult = sent.find((m) => m.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({ toolId: 'tool-1', result: 'hi\n', isError: false });

    // No old-style tool_call event
    expect(sent.some((m) => m.type === 'tool_call')).toBe(false);
  });

  it('emits tool_result with isError=true when is_error flag set', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-err' } } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', name: 'Bash', id: 'tool-err' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-err' },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-err',
              content: 'Error: not found',
              is_error: true,
            },
          ],
        },
      },
      { type: 'result', session_id: 'sess-err' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const toolResult = ws.sent.find((m) => m.type === 'tool_result');
    expect(toolResult).toMatchObject({ toolId: 'tool-err', isError: true });
  });

  it('calls setSessionId and sends session_id on first assistant event', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'assistant', message: { content: [] }, session_id: 'sess-new' },
      { type: 'result', session_id: 'sess-new' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    expect(registry.setSessionId).toHaveBeenCalledWith(clientId, 'sess-new');
    const sessionIdMsgs = ws.sent.filter((m) => m.type === 'session_id');
    expect(sessionIdMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('emits session_end exactly once on clean finish', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'assistant', message: { content: [] }, session_id: 'sess-x' },
      { type: 'result', session_id: 'sess-x' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const sessionEnds = ws.sent.filter((m) => m.type === 'session_end');
    expect(sessionEnds).toHaveLength(1);
  });

  it('defers message_end until all blocks are closed', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-defer' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hi' },
        },
      },
      // assistant fires BEFORE content_block_stop
      { type: 'assistant', message: { content: [] }, session_id: 'sess-defer' },
      // block_stop arrives after assistant
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'result', session_id: 'sess-defer' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    const sent = ws.sent;
    const blockEndIdx = sent.findIndex((m) => m.type === 'block_end' && m.blockType === 'text');
    const messageEndIdx = sent.findIndex((m) => m.type === 'message_end');
    expect(blockEndIdx).toBeGreaterThan(-1);
    expect(messageEndIdx).toBeGreaterThan(-1);
    expect(blockEndIdx).toBeLessThan(messageEndIdx);
  });

  it('does not emit old-style text or text_delta events', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-nodupe' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello world' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
        session_id: 'sess-1',
      },
      { type: 'result', session_id: 'sess-1' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController, ws);

    expect(ws.sent.some((m) => m.type === 'text')).toBe(false);
    expect(ws.sent.some((m) => m.type === 'text_delta')).toBe(false);
    expect(ws.sent.some((m) => m.type === 'done')).toBe(false);

    // v2 equivalents ARE present
    expect(ws.sent.some((m) => m.type === 'block_delta')).toBe(true);
    expect(ws.sent.some((m) => m.type === 'session_end')).toBe(true);
  });
});
