import { expect, it, vi } from 'vitest';
import { runQueryLoop } from '../query-loop.js';
import { EventStore } from '../event-store.js';
import { replayEventsToMessages } from '../conversation-transcript.js';
import { ClaudeMessageRetractions } from '../claude-message-retractions.js';
import type { SessionRegistry } from '../session-registry.js';
import { sessionHistoryTools, type HistoryAccess } from '../session-history-tools.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import { AsyncQueue } from '../async-queue.js';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  messagesReducer,
  INITIAL_MESSAGES_STATE,
} from '../../packages/client/src/slices/messages.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const sessionId = 'aaaabbbb-1111-4222-8333-444455556666';
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const notice = '33333333-3333-4333-8333-333333333333';

it.each(
  ['before-stop', 'after-stop'].flatMap((order) =>
    ['notice', 'supersedes'].map((receipt) => ({ order, receipt })),
  ),
)('retracts all per-block SDK assistant frames (%j)', async ({ order, receipt }) => {
  // sdk.d.ts:3741: one assistant envelope per completed content block;
  // multiple envelopes share message.id. Probe both adjacent stop orderings.
  const raw: Record<string, unknown>[] = [];
  const push = (event: Record<string, unknown>) =>
    raw.push({
      type: 'stream_event',
      session_id: sessionId,
      parent_tool_use_id: null,
      event,
    });
  push({ type: 'message_start', message: { id: 'msg_multi', usage: { input_tokens: 1 } } });
  const toolFrame = '44444444-4444-4444-8444-444444444444';
  const frames = [
    {
      index: 0,
      uuid: first,
      text: 'WITHDRAWN_FIRST',
      type: receipt === 'supersedes' ? 'thinking' : 'text',
    },
    { index: 1, uuid: second, text: 'WITHDRAWN_SECOND', type: 'text' },
    ...(receipt === 'supersedes'
      ? [{ index: 2, uuid: toolFrame, text: '{}', type: 'tool_use' }]
      : []),
  ];
  for (const { index, uuid, text, type } of frames) {
    push({
      type: 'content_block_start',
      index,
      content_block: {
        type,
        text: '',
        ...(type === 'tool_use' ? { id: 'known-tool', name: 'Read', input: {} } : {}),
      },
    });
    push({
      type: 'content_block_delta',
      index,
      delta:
        type === 'thinking'
          ? { type: 'thinking_delta', thinking: text }
          : type === 'tool_use'
            ? { type: 'input_json_delta', partial_json: text }
            : { type: 'text_delta', text },
    });
    const envelope = {
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: null,
      uuid,
      message: { id: 'msg_multi', role: 'assistant', content: [{ type, text }], stop_reason: null },
    };
    if (order === 'before-stop') raw.push(envelope);
    push({ type: 'content_block_stop', index });
    if (order === 'after-stop') raw.push(envelope);
  }
  push({ type: 'message_stop' });
  if (receipt === 'notice') {
    raw.push({
      type: 'system',
      subtype: 'model_refusal_fallback',
      session_id: sessionId,
      uuid: notice,
      retracted_message_uuids: [first, second],
    });
  } else {
    push({ type: 'message_start', message: { id: 'replacement', usage: { input_tokens: 1 } } });
    push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'REPLACEMENT' },
    });
    push({ type: 'content_block_stop', index: 0 });
    raw.push({
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: null,
      uuid: notice,
      message: { id: 'replacement', content: [{ type: 'text', text: 'REPLACEMENT' }] },
      supersedes: [first, second, toolFrame],
    });
  }
  raw.push({ type: 'result', session_id: sessionId, is_error: false });
  const transport = { send: vi.fn(), isOpen: () => true };
  const session = {
    transport,
    sessionId,
    accountBinding: {
      provider: order === 'before-stop' ? 'anthropic-claude' : 'anthropic-vertex',
      accountId: 'synthetic',
      profileRevision: 'fixed',
      accountLabel: 'Synthetic',
      model: 'synthetic',
    },
    observers: new Set(),
    currentSnapshot: null,
    cumulativeSessionTokens: 0,
    cumulativeCostUsd: 0,
  };
  const registry = {
    get: () => session,
    findBySessionId: () => undefined,
    setSessionId: () => {},
    remove: () => {},
    isAttached: () => true,
    isSuspended: () => false,
    bufferEvent: () => false,
  } as unknown as SessionRegistry;
  const store = new EventStore(':memory:');
  store.upsertSession({ sessionId, cwd: '/task' });
  const controller = new AbortController();
  vi.mocked(query).mockReturnValue({
    close: vi.fn(),
    [Symbol.asyncIterator]: () =>
      (async function* () {
        yield* raw;
      })(),
  } as never);
  const sdk = createOrdinaryLocalVertexSdkQuery<AsyncIterable<Record<string, unknown>>>({
    options: { sessionId },
    input: new AsyncQueue(),
    controller,
    lifetime: new SdkHookLifetime(),
    sdkSessionId: sessionId,
    cwd: '/task',
    authorize: async () => {},
    authorizeSync: () => {},
    adapt: (native) => native as never,
    settings: () => ({}),
    inputChanged: () => {},
    onUnsent: (_input, cause) => {
      throw cause;
    },
  });
  // Consecutive normalized blocks can arrive within the same millisecond.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    await runQueryLoop(sdk.query, 'client', registry, controller, store, undefined, {
      onResultDelivered: async () => (sdk.query as unknown as { close(): void }).close(),
    });
    const events = store.getEventsAfter(sessionId, 0);
    const projected = replayEventsToMessages(events);
    expect(JSON.stringify(projected)).not.toContain('WITHDRAWN_FIRST');
    expect(JSON.stringify(projected)).not.toContain('WITHDRAWN_SECOND');
    let live = INITIAL_MESSAGES_STATE;
    for (const [event] of transport.send.mock.calls) {
      const parsed = parseServerMessage(
        event as never,
        { currentSessionId: sessionId },
        { onSessionAssigned: vi.fn(), onSessionExpired: vi.fn(), setWsRunning: vi.fn() },
        'client',
      );
      live = parsed.messagesActions.reduce(messagesReducer, live);
    }
    expect(JSON.stringify(live.messages)).not.toContain('WITHDRAWN_FIRST');
    expect(JSON.stringify(live.messages)).not.toContain('WITHDRAWN_SECOND');
    if (receipt === 'supersedes') {
      expect(JSON.stringify(live.messages)).toContain('REPLACEMENT');
      expect(JSON.stringify(live.messages)).toContain('known-tool');
      expect(JSON.stringify(projected)).toContain('known-tool');
    }
    const starts = events.filter((event) => event.type === 'message_start');
    expect(new Set(starts.map((event) => event.payload.messageId)).size).toBe(starts.length);
    expect(JSON.stringify(events)).toContain('WITHDRAWN_SECOND');
    expect(events.filter((e) => e.type === 'error').map((e) => e.payload.code)).not.toContain(
      'claude_retraction_unavailable',
    );
  } finally {
    clock.mockRestore();
    controller.abort();
    store.close();
  }
});

it.each(['local', 'unsupported'])(
  'rejects %s fallback scope without consuming an ordinary mapping',
  (scope) => {
    const owner = new ClaudeMessageRetractions();
    owner.observe(
      {
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: first,
        message: { id: 'ordinary' },
      },
      sessionId,
      'ordinary',
      new Map(),
    );
    const result = owner.observe(
      {
        type: 'system',
        subtype: 'model_refusal_fallback',
        scope,
        session_id: sessionId,
        uuid: notice,
        retracted_message_uuids: [first],
      },
      sessionId,
      null,
      new Map(),
    );
    expect(result.targets).toEqual([]);
    expect(
      owner.observe(
        {
          type: 'system',
          subtype: 'model_refusal_fallback',
          scope: 'session',
          session_id: sessionId,
          uuid: notice,
          retracted_message_uuids: [first],
        },
        sessionId,
        null,
        new Map(),
      ).targets,
    ).toEqual([{ messageId: 'ordinary' }]);
  },
);

it.each(['valid', 'tool-only', 'attributed', 'foreign', 'unknown'])(
  'qualifies history receipts outside the returned page (%s)',
  (kind) => {
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'past' });
    const append = (type: string, payload: Record<string, unknown>) =>
      store.append('past', type, payload);
    append('user_message', { messageId: 'input', text: 'Keep user input' });
    append('message_start', { messageId: 'old' });
    append('block_start', { messageId: 'old', blockId: 'text', blockType: 'text' });
    const delta = append('block_delta', {
      messageId: 'old',
      blockId: 'text',
      blockType: 'text',
      delta: 'WITHDRAWN_PAGE_TEXT',
    });
    append('block_end', {
      messageId: 'old',
      blockId: 'tool',
      blockType: 'tool_use',
      toolId: 'known',
    });
    const before = append('message_end', { messageId: 'old' });
    const through = append('message_retracted', {
      sessionId: kind === 'foreign' ? 'foreign' : 'past',
      messageId: kind === 'unknown' ? 'unknown' : 'old',
      ...(kind === 'tool-only' ? { toolId: 'known' } : {}),
      ...(kind === 'attributed' ? { seatId: null } : {}),
    });
    try {
      const read = () => store.getHistoryEventPage('past', 0, through, 4);
      if (kind === 'foreign' || kind === 'unknown') {
        expect(read).toThrow('no matching ordinary output identity');
        return;
      }
      const page = read();
      expect(page.hasMore).toBe(true);
      expect(page.events.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
      expect(page.events.at(-1)?.payload.delta).toBe(
        kind === 'valid' ? null : 'WITHDRAWN_PAGE_TEXT',
      );
      expect(store.getHistoryEventPage('past', 0, before, 4).events.at(-1)?.payload.delta).toBe(
        'WITHDRAWN_PAGE_TEXT',
      );
      expect(
        store.getHistoryMessagePrefix('past', 'old', delta + 1, 4, through)[0].payload.delta,
      ).toBe(kind === 'valid' ? null : 'WITHDRAWN_PAGE_TEXT');
      expect(JSON.stringify(store.getSessionEvents('past'))).toContain('WITHDRAWN_PAGE_TEXT');
    } finally {
      store.close();
    }
  },
);

it.each(['forward', 'recent', 'query', 'search', 'frozen'])(
  'qualifies retractions in public history %s',
  async (mode) => {
    const store = new EventStore(':memory:');
    store.upsertSession({
      sessionId: 'past',
      conversationSource: 'mitzo',
      summary: 'Unrelated title',
    });
    const append = (type: string, payload: Record<string, unknown>) =>
      store.append('past', type, payload);
    append('user_message', { messageId: 'input', text: 'Keep the request' });
    append('message_start', { messageId: 'old' });
    append('block_start', { messageId: 'old', blockId: 'text', blockType: 'text' });
    append('block_delta', {
      messageId: 'old',
      blockId: 'text',
      blockType: 'text',
      delta: 'WITHDRAWN_HISTORY_TEXT',
    });
    append('block_end', { messageId: 'old', blockId: 'text', blockType: 'text' });
    const before = append('message_end', { messageId: 'old' });
    append('message_retracted', { sessionId: 'past', messageId: 'old' });
    const signal = new AbortController().signal;
    const access: HistoryAccess = {
      signal,
      assertCurrent() {},
      async assertCurrentAsync() {},
      async authorizeSearch() {},
      allowTranscriptSearch: () => true,
      async authorizeRead() {
        return { assertCurrent() {} };
      },
      readBoundary: (id) => store.captureReconnectState(id, 0, false).cursor,
      dispose() {},
    };
    const tools = sessionHistoryTools({
      store,
      capture: () => access,
      projectPublicText: (text) => text,
    });
    try {
      const result = await tools.execute(
        mode === 'search' ? 'SearchPastSessions' : 'ReadPastSession',
        mode === 'search'
          ? { query: 'WITHDRAWN_HISTORY_TEXT', scope: 'all' }
          : {
              conversationId: 'past',
              ...(mode === 'recent' ? { recent: true } : {}),
              ...(mode === 'query' ? { query: 'WITHDRAWN_HISTORY_TEXT' } : {}),
              ...(mode === 'frozen' ? { throughSeq: before } : {}),
            },
        signal,
        { turnId: 'review', callId: mode },
      );
      expect(result?.isError).toBe(false);
      if (mode === 'search') expect(JSON.parse(result!.content).sessions).toEqual([]);
      else if (mode === 'frozen') expect(result?.content).toContain('WITHDRAWN_HISTORY_TEXT');
      else expect(result?.content).not.toContain('WITHDRAWN_HISTORY_TEXT');
      expect(JSON.stringify(store.getSessionEvents('past'))).toContain('WITHDRAWN_HISTORY_TEXT');
    } finally {
      store.close();
    }
  },
);
