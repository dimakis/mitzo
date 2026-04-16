import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionTransport } from '../../packages/harness/src/session-transport.js';
import { runQueryLoop } from '../query-loop.js';
import type { SessionRegistry } from '../session-registry.js';
import { EventStore } from '../event-store.js';

/** Create a fake SessionTransport that records sent messages */
function fakeTransport(): SessionTransport & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    send: vi.fn((data: Record<string, unknown>) => sent.push(data)),
    isOpen: () => true,
    sent,
  } as unknown as SessionTransport & { sent: Record<string, unknown>[] };
}

/** Create a minimal SessionRegistry stub with currentSnapshot support */
function fakeRegistry(
  transport: SessionTransport,
  opts?: { attached?: boolean; observers?: Set<SessionTransport> },
): SessionRegistry {
  let removed = false;
  let attached = opts?.attached ?? true;
  const session = {
    transport,
    sessionId: undefined as string | undefined,
    currentSnapshot: null as null | { messageId: string; blocks: unknown[] },
    observers: opts?.observers ?? new Set<SessionTransport>(),
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
    isAttached: vi.fn(() => attached),
    _setAttached: (v: boolean) => {
      attached = v;
    },
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
  let transport: SessionTransport & { sent: Record<string, unknown>[] };
  let registry: SessionRegistry;
  const clientId = 'test-client';
  let abortController: AbortController;

  beforeEach(() => {
    transport = fakeTransport();
    registry = fakeRegistry(transport);
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

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const sent = transport.sent;
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

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const sent = transport.sent;
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
    expect(sent.some((m: Record<string, unknown>) => m.type === 'thinking_start')).toBe(false);
    expect(sent.some((m: Record<string, unknown>) => m.type === 'thinking_delta')).toBe(false);
    expect(sent.some((m: Record<string, unknown>) => m.type === 'text_delta')).toBe(false);
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

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const sent = transport.sent;

    const blockStart = sent.find(
      (m: Record<string, unknown>) => m.type === 'block_start' && m.blockType === 'tool_use',
    );
    expect(blockStart).toBeDefined();
    expect(blockStart).toMatchObject({ toolName: 'Bash' });

    const blockEnd = sent.find(
      (m: Record<string, unknown>) => m.type === 'block_end' && m.blockType === 'tool_use',
    );
    expect(blockEnd).toBeDefined();
    expect(blockEnd).toMatchObject({ toolName: 'Bash', toolId: 'tool-1' });

    const toolResult = sent.find((m: Record<string, unknown>) => m.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({ toolId: 'tool-1', result: 'hi\n', isError: false });

    // No old-style tool_call event
    expect(sent.some((m: Record<string, unknown>) => m.type === 'tool_call')).toBe(false);
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

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const toolResult = transport.sent.find(
      (m: Record<string, unknown>) => m.type === 'tool_result',
    );
    expect(toolResult).toMatchObject({ toolId: 'tool-err', isError: true });
  });

  it('calls setSessionId and sends session_id on first assistant event', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'assistant', message: { content: [] }, session_id: 'sess-new' },
      { type: 'result', session_id: 'sess-new' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    expect(registry.setSessionId).toHaveBeenCalledWith(clientId, 'sess-new');
    const sessionIdMsgs = transport.sent.filter(
      (m: Record<string, unknown>) => m.type === 'session_id',
    );
    expect(sessionIdMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('emits session_end exactly once on clean finish', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'assistant', message: { content: [] }, session_id: 'sess-x' },
      { type: 'result', session_id: 'sess-x' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const sessionEnds = transport.sent.filter(
      (m: Record<string, unknown>) => m.type === 'session_end',
    );
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

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const sent = transport.sent;
    const blockEndIdx = sent.findIndex(
      (m: Record<string, unknown>) => m.type === 'block_end' && m.blockType === 'text',
    );
    const messageEndIdx = sent.findIndex((m: Record<string, unknown>) => m.type === 'message_end');
    expect(blockEndIdx).toBeGreaterThan(-1);
    expect(messageEndIdx).toBeGreaterThan(-1);
    expect(blockEndIdx).toBeLessThan(messageEndIdx);
  });

  it('flushes pending message_end when new message_start arrives (multi-turn race)', async () => {
    const events: Record<string, unknown>[] = [
      // Turn 1: thinking block, assistant fires before block_stop
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-t1' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
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
          delta: { type: 'text_delta', text: 'Turn 1 response' },
        },
      },
      // assistant fires BEFORE content_block_stop for the text block
      { type: 'assistant', message: { content: [] }, session_id: 'sess-mt' },
      // Turn 2 starts before Turn 1's text block_stop arrives
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-t2' } } },
      // Turn 1's block_stop is now orphaned — server should have force-flushed
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Turn 2 response' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-mt' },
      { type: 'result', session_id: 'sess-mt' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const sent = transport.sent;

    // Turn 1 message_end must exist and come before Turn 2 message_start
    const t1MsgEnd = sent.findIndex(
      (m: Record<string, unknown>) => m.type === 'message_end' && m.messageId === 'msg-t1',
    );
    const t2MsgStart = sent.findIndex(
      (m: Record<string, unknown>) => m.type === 'message_start' && m.messageId === 'msg-t2',
    );
    expect(t1MsgEnd).toBeGreaterThan(-1);
    expect(t2MsgStart).toBeGreaterThan(-1);
    expect(t1MsgEnd).toBeLessThan(t2MsgStart);

    // Turn 2 message_end must also exist
    const t2MsgEnd = sent.findIndex(
      (m: Record<string, unknown>) => m.type === 'message_end' && m.messageId === 'msg-t2',
    );
    expect(t2MsgEnd).toBeGreaterThan(t2MsgStart);
  });

  it('drops messages when session is detached (recovery via event store)', async () => {
    // Start attached, then detach mid-stream
    registry = fakeRegistry(transport);
    const reg = registry as unknown as {
      _setAttached: (v: boolean) => void;
    };

    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-detach' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'before detach' },
        },
      },
    ];

    const detachedEvents: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' after detach' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-detach' },
      { type: 'result', session_id: 'sess-detach' },
    ];

    async function* detachingStream() {
      for (const e of events) yield e;
      reg._setAttached(false);
      for (const e of detachedEvents) yield e;
    }

    await runQueryLoop(detachingStream(), clientId, registry, abortController);

    // Messages sent while attached should be on the transport
    expect(transport.sent.some((m: Record<string, unknown>) => m.type === 'message_start')).toBe(
      true,
    );
    const attachedDeltas = transport.sent.filter(
      (m: Record<string, unknown>) => m.type === 'block_delta' && m.delta === 'before detach',
    );
    expect(attachedDeltas).toHaveLength(1);

    // Messages sent while detached should NOT be on the transport
    const detachedDeltas = transport.sent.filter(
      (m: Record<string, unknown>) => m.type === 'block_delta' && m.delta === ' after detach',
    );
    expect(detachedDeltas).toHaveLength(0);
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

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    expect(transport.sent.some((m: Record<string, unknown>) => m.type === 'text')).toBe(false);
    expect(transport.sent.some((m: Record<string, unknown>) => m.type === 'text_delta')).toBe(
      false,
    );
    expect(transport.sent.some((m: Record<string, unknown>) => m.type === 'done')).toBe(false);

    // v2 equivalents ARE present
    expect(transport.sent.some((m: Record<string, unknown>) => m.type === 'block_delta')).toBe(
      true,
    );
    expect(transport.sent.some((m: Record<string, unknown>) => m.type === 'session_end')).toBe(
      true,
    );
  });

  it('does not emit user_message for SDK user events with string content', async () => {
    // SDK user events are internal API conversation turns (agent sub-prompts,
    // multi-turn machinery). Only entry points (startChat, sendToChat,
    // interruptChat) should persist user_message events.
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-a1' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Response' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-um' },
      { type: 'user', message: { role: 'user', content: 'Follow-up question' } },
      { type: 'result', session_id: 'sess-um' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const userMsg = transport.sent.find((m: Record<string, unknown>) => m.type === 'user_message');
    expect(userMsg).toBeUndefined();
  });

  it('does not emit user_message for SDK user events with text content blocks', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-a2' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Response' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-um2' },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Another question' }],
        },
      },
      { type: 'result', session_id: 'sess-um2' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const userMsg = transport.sent.find((m: Record<string, unknown>) => m.type === 'user_message');
    expect(userMsg).toBeUndefined();
  });

  it('emits only tool_result (not user_message) for mixed content blocks', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-mix' } } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', name: 'Bash', id: 'tool-mix' },
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
      { type: 'assistant', message: { content: [] }, session_id: 'sess-mix' },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is context' },
            { type: 'tool_result', tool_use_id: 'tool-mix', content: 'output' },
          ],
        },
      },
      { type: 'result', session_id: 'sess-mix' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    // Text content from SDK user events must NOT produce user_message
    const userMsg = transport.sent.find((m: Record<string, unknown>) => m.type === 'user_message');
    expect(userMsg).toBeUndefined();

    // tool_result extraction should still work
    const toolResult = transport.sent.find(
      (m: Record<string, unknown>) => m.type === 'tool_result',
    );
    expect(toolResult).toBeDefined();
    expect(toolResult).toMatchObject({ toolId: 'tool-mix' });
  });

  it('does not emit user_message for SDK user events with multiple text blocks', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-cat' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Response' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { content: [] }, session_id: 'sess-cat' },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Part one' },
            { type: 'text', text: 'Part two' },
          ],
        },
      },
      { type: 'result', session_id: 'sess-cat' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const userMsgs = transport.sent.filter(
      (m: Record<string, unknown>) => m.type === 'user_message',
    );
    expect(userMsgs).toHaveLength(0);
  });

  it('does not emit user_message for user messages with only tool_result blocks', async () => {
    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-tr' } } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', name: 'Bash', id: 'tool-only' },
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
      { type: 'assistant', message: { content: [] }, session_id: 'sess-tr' },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-only', content: 'result' }],
        },
      },
      { type: 'result', session_id: 'sess-tr' },
    ];

    await runQueryLoop(eventStream(events), clientId, registry, abortController);

    const userMsg = transport.sent.find((m: Record<string, unknown>) => m.type === 'user_message');
    expect(userMsg).toBeUndefined();
  });

  describe('EventStore integration', () => {
    let store: EventStore;

    beforeEach(() => {
      store = new EventStore(':memory:');
    });

    afterEach(() => {
      store.close();
    });

    it('appends v2 events to the store when store is provided', async () => {
      // Set sessionId on the registry session so append knows the session
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-store';

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-s1' } } },
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
        { type: 'assistant', message: { content: [] }, session_id: 'sess-store' },
        { type: 'result', session_id: 'sess-store' },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      const stored = store.getSessionEvents('sess-store');
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.some((e) => e.type === 'message_start')).toBe(true);
      expect(stored.some((e) => e.type === 'block_delta')).toBe(true);
      expect(stored.some((e) => e.type === 'message_end')).toBe(true);
      expect(stored.some((e) => e.type === 'session_end')).toBe(true);
    });

    it('injects seq into sent transport messages when store is provided', async () => {
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-seq';

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-seq' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hi' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-seq' },
        { type: 'result', session_id: 'sess-seq' },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      // All v2 messages should have a seq field
      const v2Messages = transport.sent.filter((m: Record<string, unknown>) => m.v === 2);
      expect(v2Messages.length).toBeGreaterThan(0);
      for (const msg of v2Messages) {
        expect(msg.seq).toEqual(expect.any(Number));
      }

      // Seq numbers should be monotonically increasing
      const seqs = v2Messages.map((m: Record<string, unknown>) => m.seq as number);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });

    it('persists events even when session is detached', async () => {
      registry = fakeRegistry(transport);
      const reg = registry as unknown as { _setAttached: (v: boolean) => void };
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-detach-store';

      async function* detachingStream() {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-ds' } },
        };
        // Detach after message_start
        reg._setAttached(false);
        yield {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'while detached' },
          },
        };
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } };
        yield { type: 'assistant', message: { content: [] }, session_id: 'sess-detach-store' };
        yield { type: 'result', session_id: 'sess-detach-store' };
      }

      await runQueryLoop(detachingStream(), clientId, registry, abortController, store);

      // Events should be in the store regardless of attachment state
      const stored = store.getSessionEvents('sess-detach-store');
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.some((e) => e.type === 'block_delta')).toBe(true);
      expect(stored.some((e) => e.type === 'session_end')).toBe(true);
    });

    it('persists initial prompt on session metadata when sessionId resolves', async () => {
      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-ip' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Response' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-ip' },
        { type: 'result', session_id: 'sess-ip' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        store,
        'Hello, this is my first message',
      );

      // Initial prompt is stored on session metadata, not as an event
      const session = store.getSession('sess-ip');
      expect(session).toBeTruthy();
      expect(session!.initialPrompt).toBe('Hello, this is my first message');

      // No user_message event should be in the event stream
      const stored = store.getSessionEvents('sess-ip');
      const userMsgEvents = stored.filter((e) => e.type === 'user_message');
      expect(userMsgEvents).toHaveLength(0);
    });

    it('persists follow-up user_message from sendToChat in the event store', async () => {
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-followup';

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-fu' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'First response' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-followup' },
        { type: 'result', session_id: 'sess-followup' },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      // Simulate what sendToChat would do — persist directly to store
      store.append('sess-followup', 'user_message', {
        v: 2,
        type: 'user_message',
        ts: Date.now(),
        messageId: 'umsg-test',
        text: 'Follow-up question',
      });

      const stored = store.getSessionEvents('sess-followup');
      const userMsgs = stored.filter((e) => e.type === 'user_message');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].payload).toMatchObject({ text: 'Follow-up question' });
    });

    it('works without a store (backward compatible)', async () => {
      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-nostore' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'no store' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-ns' },
        { type: 'result', session_id: 'sess-ns' },
      ];

      // No store argument — should work exactly as before
      await runQueryLoop(eventStream(events), clientId, registry, abortController);

      expect(transport.sent.some((m: Record<string, unknown>) => m.type === 'message_start')).toBe(
        true,
      );
      // v2 messages should NOT have seq when no store
      const v2Messages = transport.sent.filter((m: Record<string, unknown>) => m.v === 2);
      for (const msg of v2Messages) {
        expect(msg.seq).toBeUndefined();
      }
    });
  });

  describe('usage data extraction', () => {
    let store: EventStore;

    beforeEach(() => {
      store = new EventStore(':memory:');
    });

    afterEach(() => {
      store.close();
    });

    it('extracts usage data from SDK result event and persists to store', async () => {
      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-usage' },
        {
          type: 'result',
          session_id: 'sess-usage',
          usage: {
            input_tokens: 1500,
            output_tokens: 800,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 50,
          },
          total_cost_usd: 0.0042,
          num_turns: 3,
          duration_ms: 12000,
          duration_api_ms: 8000,
        },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      const session = store.getSession('sess-usage');
      expect(session).not.toBeNull();
      expect(session!.inputTokens).toBe(1500);
      expect(session!.outputTokens).toBe(800);
      expect(session!.cacheReadTokens).toBe(200);
      expect(session!.cacheCreationTokens).toBe(50);
      expect(session!.totalCostUsd).toBeCloseTo(0.0042);
      expect(session!.numTurns).toBe(3);
      expect(session!.durationMs).toBe(12000);
      expect(session!.durationApiMs).toBe(8000);
    });

    it('includes usage data in session_end message', async () => {
      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-usage-msg' },
        {
          type: 'result',
          session_id: 'sess-usage-msg',
          usage: {
            input_tokens: 2000,
            output_tokens: 1000,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 25,
          },
          total_cost_usd: 0.005,
          num_turns: 2,
          duration_ms: 8000,
          duration_api_ms: 5000,
        },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      const sessionEnd = transport.sent.find(
        (m: Record<string, unknown>) => m.type === 'session_end',
      );
      expect(sessionEnd).toBeDefined();
      expect(sessionEnd!.usage).toBeDefined();
      expect(sessionEnd!.usage).toMatchObject({
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadTokens: 100,
        cacheCreationTokens: 25,
        totalCostUsd: 0.005,
        numTurns: 2,
        durationMs: 8000,
        durationApiMs: 5000,
      });
    });

    it('handles missing usage fields gracefully (defaults to 0)', async () => {
      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-no-usage' },
        {
          type: 'result',
          session_id: 'sess-no-usage',
          // No usage data provided
        },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      const sessionEnd = transport.sent.find(
        (m: Record<string, unknown>) => m.type === 'session_end',
      );
      expect(sessionEnd).toBeDefined();
      expect(sessionEnd!.usage).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        numTurns: 0,
        durationMs: 0,
        durationApiMs: 0,
      });

      const session = store.getSession('sess-no-usage');
      expect(session!.inputTokens).toBe(0);
      expect(session!.outputTokens).toBe(0);
    });

    it('handles partial usage data (some fields present)', async () => {
      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-partial' },
        {
          type: 'result',
          session_id: 'sess-partial',
          usage: {
            input_tokens: 500,
            output_tokens: 300,
            // cache fields missing
          },
          total_cost_usd: 0.002,
          // num_turns, duration_ms, duration_api_ms missing
        },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      const session = store.getSession('sess-partial');
      expect(session!.inputTokens).toBe(500);
      expect(session!.outputTokens).toBe(300);
      expect(session!.cacheReadTokens).toBe(0);
      expect(session!.cacheCreationTokens).toBe(0);
      expect(session!.totalCostUsd).toBeCloseTo(0.002);
      expect(session!.numTurns).toBe(0);
      expect(session!.durationMs).toBe(0);
      expect(session!.durationApiMs).toBe(0);
    });
  });

  describe('observer broadcast', () => {
    it('sends events to observer transports alongside the driver', async () => {
      const observerTransport = fakeTransport();
      const observers = new Set<SessionTransport>([observerTransport]);
      registry = fakeRegistry(transport, { observers });

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-obs' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello observer' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-obs' },
        { type: 'result', session_id: 'sess-obs' },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController);

      // Observer should receive the same v2 events as the driver
      expect(
        observerTransport.sent.some((m: Record<string, unknown>) => m.type === 'message_start'),
      ).toBe(true);
      expect(
        observerTransport.sent.some((m: Record<string, unknown>) => m.type === 'block_delta'),
      ).toBe(true);
      expect(
        observerTransport.sent.some((m: Record<string, unknown>) => m.type === 'session_end'),
      ).toBe(true);
    });

    it('does not fail when observer transport is closed', async () => {
      const closedTransport = fakeTransport();
      (closedTransport as any).isOpen = () => false;
      const observers = new Set<SessionTransport>([closedTransport]);
      registry = fakeRegistry(transport, { observers });

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-cobs' } } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-cobs' },
        { type: 'result', session_id: 'sess-cobs' },
      ];

      await expect(
        runQueryLoop(eventStream(events), clientId, registry, abortController),
      ).resolves.toBeUndefined();

      // Closed observer should not receive any messages
      expect(closedTransport.sent).toHaveLength(0);
    });
  });
});
