import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionTransport } from '../../packages/harness/src/session-transport.js';
import { ConnectionRegistry } from '../../packages/harness/src/connection-registry.js';
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
    isSuspended: vi.fn(() => false),
    bufferEvent: vi.fn(() => false),
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

  it('buffers events to registry when session is suspended', async () => {
    let suspended = false;
    const buffered: Record<string, unknown>[] = [];
    registry = {
      ...registry,
      isSuspended: vi.fn(() => suspended),
      bufferEvent: vi.fn((_cid: string, event: Record<string, unknown>) => {
        buffered.push(event);
        return true;
      }),
    } as unknown as typeof registry;

    const events: Record<string, unknown>[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-sus' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'before suspend' },
        },
      },
    ];

    const suspendedEvents: Record<string, unknown>[] = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'while suspended' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'result', session_id: 'sess-sus' },
    ];

    async function* suspendingStream() {
      for (const e of events) yield e;
      suspended = true;
      for (const e of suspendedEvents) yield e;
    }

    await runQueryLoop(suspendingStream(), clientId, registry, abortController);

    expect(transport.sent.some((m: Record<string, unknown>) => m.delta === 'before suspend')).toBe(
      true,
    );
    expect(transport.sent.some((m: Record<string, unknown>) => m.delta === 'while suspended')).toBe(
      false,
    );
    expect(buffered.length).toBeGreaterThan(0);
    expect(buffered.some((e) => e.type === 'block_delta')).toBe(true);
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

      // Initial prompt is stored on session metadata
      const session = store.getSession('sess-ip');
      expect(session).toBeTruthy();
      expect(session!.initialPrompt).toBe('Hello, this is my first message');

      // Initial prompt is also stored as a user_message event for auto-rename
      const stored = store.getSessionEvents('sess-ip');
      const userMsgEvents = stored.filter((e) => e.type === 'user_message');
      expect(userMsgEvents).toHaveLength(1);
      expect(userMsgEvents[0].payload.text).toBe('Hello, this is my first message');
    });

    it('calls onInitialPrompt callback when initial prompt is registered', async () => {
      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-cb' },
        { type: 'result', session_id: 'sess-cb' },
      ];

      const onInitialPrompt = vi.fn();

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        store,
        'trigger callback please',
        { onInitialPrompt },
      );

      expect(onInitialPrompt).toHaveBeenCalledWith('sess-cb');
      expect(onInitialPrompt).toHaveBeenCalledTimes(1);
    });

    it('does not call onInitialPrompt when there is no initial prompt', async () => {
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-no-ip';

      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-no-ip' },
        { type: 'result', session_id: 'sess-no-ip' },
      ];

      const onInitialPrompt = vi.fn();

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        store,
        undefined,
        { onInitialPrompt },
      );

      expect(onInitialPrompt).not.toHaveBeenCalled();
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

    it('flushes pre-sessionId events to store when sessionId resolves (new session)', async () => {
      // Simulate a brand-new session: no sessionId pre-set on the registry.
      // Events emitted before the `assistant` completion should be buffered
      // and retroactively persisted once the sessionId is known.
      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-flush' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'buffered content' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-flush' },
        { type: 'result', session_id: 'sess-flush' },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      const stored = store.getSessionEvents('sess-flush');
      // All event types should be present — including those emitted before sessionId
      expect(stored.some((e) => e.type === 'message_start')).toBe(true);
      expect(stored.some((e) => e.type === 'block_start')).toBe(true);
      expect(stored.some((e) => e.type === 'block_delta')).toBe(true);
      expect(stored.some((e) => e.type === 'block_end')).toBe(true);
      expect(stored.some((e) => e.type === 'message_end')).toBe(true);
    });

    it('persists events immediately when sessionId is pre-set (resumed session)', async () => {
      // Simulate a resumed session: sessionId is known before the query loop
      // starts (set by startChat passing options.resume to registry.register).
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-resume-persist';

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-rp' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'resumed content' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-resume-persist' },
        { type: 'result', session_id: 'sess-resume-persist' },
      ];

      await runQueryLoop(eventStream(events), clientId, registry, abortController, store);

      const stored = store.getSessionEvents('sess-resume-persist');
      expect(stored.some((e) => e.type === 'message_start')).toBe(true);
      expect(stored.some((e) => e.type === 'block_delta')).toBe(true);
      expect(stored.some((e) => e.type === 'message_end')).toBe(true);

      // All v2 events should have the sessionId tag
      for (const e of stored) {
        expect(e.payload.sessionId).toBe('sess-resume-persist');
      }
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

  describe('v2 ConnectionRegistry delivery', () => {
    it('routes events through connRegistry.broadcast when clientId is a v2 connection', async () => {
      const connRegistry = new ConnectionRegistry();
      const v2Transport = fakeTransport();
      connRegistry.register(clientId, v2Transport);
      connRegistry.watch(clientId, 'sess-v2');
      connRegistry.setActive(clientId, 'sess-v2');

      // Pre-set sessionId so broadcast has a target from the start
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-v2';

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-v2' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'v2 hello' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-v2' },
        { type: 'result', session_id: 'sess-v2' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        undefined,
        undefined,
        { connRegistry },
      );

      // v2Transport should receive events via connRegistry.broadcast
      expect(v2Transport.sent.some((m) => m.type === 'message_start')).toBe(true);
      expect(v2Transport.sent.some((m) => m.type === 'block_delta')).toBe(true);
      expect(v2Transport.sent.some((m) => m.type === 'session_end')).toBe(true);
    });

    it('falls back to v1 path when clientId is NOT in connRegistry', async () => {
      const connRegistry = new ConnectionRegistry();
      // Do NOT register clientId in connRegistry — it's a v1 connection

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-v1' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'v1 hello' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-v1' },
        { type: 'result', session_id: 'sess-v1' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        undefined,
        undefined,
        { connRegistry },
      );

      // Driver transport should still receive events (v1 path)
      expect(transport.sent.some((m) => m.type === 'message_start')).toBe(true);
      expect(transport.sent.some((m) => m.type === 'block_delta')).toBe(true);
      expect(transport.sent.some((m) => m.type === 'session_end')).toBe(true);
    });

    it('falls back to direct driver send before sessionId is resolved', async () => {
      const connRegistry = new ConnectionRegistry();
      const v2Transport = fakeTransport();
      connRegistry.register(clientId, v2Transport);

      // sessionId not pre-set — will be resolved on first assistant event
      // Provide onSessionResolved to auto-watch (mirrors handleSendV2 behavior)
      const onSessionResolved = (sessionId: string) => {
        connRegistry.watch(clientId, sessionId);
        connRegistry.setActive(clientId, sessionId);
      };

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-pre' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'before sessionId' },
          },
        },
        // assistant resolves sessionId
        { type: 'assistant', message: { content: [] }, session_id: 'sess-late' },
        // After sessionId resolved, events should go through connRegistry
        {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-post' } },
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
            delta: { type: 'text_delta', text: 'after sessionId' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-late' },
        { type: 'result', session_id: 'sess-late' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        undefined,
        undefined,
        { connRegistry, onSessionResolved },
      );

      // Pre-sessionId events should still reach the driver transport (v1 fallback)
      expect(transport.sent.some((m) => m.type === 'message_start')).toBe(true);

      // Post-sessionId events should reach v2Transport via broadcast
      expect(v2Transport.sent.some((m) => m.type === 'session_end')).toBe(true);
    });

    it('sends session_end via connRegistry.broadcast in finally block for v2 connections', async () => {
      const connRegistry = new ConnectionRegistry();
      const v2Transport = fakeTransport();
      connRegistry.register(clientId, v2Transport);
      connRegistry.watch(clientId, 'sess-abort');
      connRegistry.setActive(clientId, 'sess-abort');

      const session = registry.get(clientId)!;
      session.sessionId = 'sess-abort';

      // Stream that errors before result (simulates abort)
      async function* errorStream() {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-abort' } },
        };
        throw new Error('connection lost');
      }

      await runQueryLoop(errorStream(), clientId, registry, abortController, undefined, undefined, {
        connRegistry,
      });

      // session_end should reach v2Transport via connRegistry in the finally block
      expect(v2Transport.sent.some((m) => m.type === 'session_end')).toBe(true);
    });

    it('delivers events to a NEW connection after WS reconnect (old connection gone)', async () => {
      const connRegistry = new ConnectionRegistry();
      const oldTransport = fakeTransport();
      const newTransport = fakeTransport();

      // Simulate initial v2 connection
      connRegistry.register(clientId, oldTransport);
      connRegistry.watch(clientId, 'sess-recon');
      connRegistry.setActive(clientId, 'sess-recon');

      // Pre-set sessionId (session already resolved from previous turn)
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-recon';

      // Simulate WS disconnect: old connection removed from connRegistry
      connRegistry.remove(clientId);

      // Simulate WS reconnect: new connection with different ID watches the session
      const newConnId = 'conn-new-after-reconnect';
      connRegistry.register(newConnId, newTransport);
      connRegistry.watch(newConnId, 'sess-recon');
      connRegistry.setActive(newConnId, 'sess-recon');

      // Query loop still uses the OLD clientId (closed over at start)
      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-recon' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hello after reconnect' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-recon' },
        { type: 'result', session_id: 'sess-recon' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId, // OLD clientId — no longer in connRegistry
        registry,
        abortController,
        undefined,
        undefined,
        { connRegistry },
      );

      // The NEW transport should receive events via broadcast
      // (even though the query loop's clientId is no longer in connRegistry)
      expect(newTransport.sent.some((m) => m.type === 'message_start')).toBe(true);
      expect(newTransport.sent.some((m) => m.type === 'block_delta')).toBe(true);
      expect(newTransport.sent.some((m) => m.type === 'session_end')).toBe(true);

      // Old transport should NOT receive anything (it was removed)
      expect(oldTransport.sent).toHaveLength(0);
    });
  });

  describe('onSessionResolved callback', () => {
    it('invokes the callback with sessionId when first resolved', async () => {
      const onResolved = vi.fn();

      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-cb' },
        { type: 'result', session_id: 'sess-cb' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        undefined,
        undefined,
        { onSessionResolved: onResolved },
      );

      expect(onResolved).toHaveBeenCalledTimes(1);
      expect(onResolved).toHaveBeenCalledWith('sess-cb');
    });

    it('does not invoke the callback on subsequent assistant events', async () => {
      const onResolved = vi.fn();

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-t1' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Turn 1' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-multi' },
        // Second assistant event (multi-turn)
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-t2' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Turn 2' },
          },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-multi' },
        { type: 'result', session_id: 'sess-multi' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        undefined,
        undefined,
        { onSessionResolved: onResolved },
      );

      expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('is not invoked when session already has sessionId (resume case)', async () => {
      const onResolved = vi.fn();
      const session = registry.get(clientId)!;
      session.sessionId = 'sess-resume';

      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-resume' },
        { type: 'result', session_id: 'sess-resume' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        undefined,
        undefined,
        { onSessionResolved: onResolved },
      );

      // Callback should not fire because sessionId was already set
      expect(onResolved).not.toHaveBeenCalled();
    });
  });

  describe('session_end cleanup via ConnectionRegistry', () => {
    it('clears activeSession on the v2 connection when session ends normally', async () => {
      const connRegistry = new ConnectionRegistry();
      const v2Transport = fakeTransport();
      connRegistry.register(clientId, v2Transport);
      connRegistry.watch(clientId, 'sess-cleanup');
      connRegistry.setActive(clientId, 'sess-cleanup');

      const session = registry.get(clientId)!;
      session.sessionId = 'sess-cleanup';

      const events: Record<string, unknown>[] = [
        { type: 'assistant', message: { content: [] }, session_id: 'sess-cleanup' },
        { type: 'result', session_id: 'sess-cleanup' },
      ];

      await runQueryLoop(
        eventStream(events),
        clientId,
        registry,
        abortController,
        undefined,
        undefined,
        { connRegistry },
      );

      const conn = connRegistry.get(clientId);
      expect(conn).toBeDefined();
      expect(conn!.activeSession).toBeNull();
      // Session should remain in watchedSessions
      expect(conn!.watchedSessions.has('sess-cleanup')).toBe(true);
    });

    it('clears activeSession in finally block when session ends abnormally', async () => {
      const connRegistry = new ConnectionRegistry();
      const v2Transport = fakeTransport();
      connRegistry.register(clientId, v2Transport);
      connRegistry.watch(clientId, 'sess-err-cleanup');
      connRegistry.setActive(clientId, 'sess-err-cleanup');

      const session = registry.get(clientId)!;
      session.sessionId = 'sess-err-cleanup';

      async function* errorStream() {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-err' } },
        };
        throw new Error('unexpected');
      }

      await runQueryLoop(errorStream(), clientId, registry, abortController, undefined, undefined, {
        connRegistry,
      });

      const conn = connRegistry.get(clientId);
      expect(conn).toBeDefined();
      expect(conn!.activeSession).toBeNull();
      expect(conn!.watchedSessions.has('sess-err-cleanup')).toBe(true);
    });
  });

  describe('first-event timeout', () => {
    it('sends an error and exits when the SDK yields no events within the timeout window', async () => {
      vi.useFakeTimers();

      // An async iterable that blocks forever on a promise that only resolves
      // when the abortController aborts — this mirrors the Agent SDK behaviour
      // of waiting on an inbound stream that never arrives (e.g. the Claude
      // Code subprocess is unreachable because the selected model is not
      // available on the configured provider).
      async function* stalled(signal: AbortSignal): AsyncIterable<Record<string, unknown>> {
        await new Promise<void>((_, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        yield {} as Record<string, unknown>;
      }

      const runPromise = runQueryLoop(
        stalled(abortController.signal),
        clientId,
        registry,
        abortController,
      );

      // Advance past the first-event timeout
      await vi.advanceTimersByTimeAsync(90_001);

      await expect(runPromise).resolves.toBeUndefined();

      expect(transport.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'error',
            error: expect.stringMatching(/did not respond|unavailable/i),
          }),
        ]),
      );

      vi.useRealTimers();
    });

    it('does not fire the timeout once the first SDK event has arrived', async () => {
      vi.useFakeTimers();

      const events: Record<string, unknown>[] = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-ok' } } },
        { type: 'assistant', message: { content: [] }, session_id: 'sess-ok' },
        { type: 'result', session_id: 'sess-ok' },
      ];

      const runPromise = runQueryLoop(eventStream(events), clientId, registry, abortController);

      // Flush the initial microtasks so the iterator produces its first event
      await vi.advanceTimersByTimeAsync(0);
      // Then blow past the timeout — nothing should happen because firstEventReceived is true
      await vi.advanceTimersByTimeAsync(120_000);

      await runPromise;

      // No error — just the normal happy-path events
      expect(transport.sent).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'error' })]),
      );

      vi.useRealTimers();
    });
  });
});
