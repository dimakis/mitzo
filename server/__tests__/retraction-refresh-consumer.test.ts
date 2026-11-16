import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { createSessionTranscriptReader } from '../session-transcript-reader.js';
import { createMitzoStore } from '../../packages/client/src/store.js';
import { metadataConnection as channel } from '../../packages/client/src/__tests__/fixtures/metadata-connection.js';

vi.mock('../../packages/client/src/sse-connection.js', async () => ({
  SseConnection: (
    await import('../../packages/client/src/__tests__/fixtures/metadata-connection.js')
  ).MetadataTestConnection,
}));
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

async function fixture(hasTool: boolean) {
  const sessionId = 'selected-chat';
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  events.upsertSession({ sessionId, cwd: '/task' });
  const append = (type: string, payload: Record<string, unknown>) =>
    events.append(sessionId, type, payload);
  append('user_message', { messageId: 'input', text: 'Keep original input.' });
  append('message_start', { messageId: 'old' });
  append('block_start', { messageId: 'old', blockId: 'text', blockType: 'text' });
  append('block_delta', {
    messageId: 'old',
    blockId: 'text',
    blockType: 'text',
    delta: 'OLD_OUTPUT',
  });
  append('block_end', { messageId: 'old', blockId: 'text', blockType: 'text' });
  if (hasTool) {
    append('block_start', { messageId: 'old', blockId: 'tool', blockType: 'tool_use' });
    append('block_end', {
      messageId: 'old',
      blockId: 'tool',
      blockType: 'tool_use',
      toolId: 'read',
      toolName: 'Read',
    });
    append('tool_result', { messageId: 'old', toolId: 'read', result: 'OLD_RESULT' });
  }
  append('message_end', { messageId: 'old' });
  const reader = createSessionTranscriptReader({
    store: events,
    getSessionDirs: async () => [],
    getSessionInfo: async () => undefined,
    getLegacyMessages: async () => [],
    getAccountMessages: async () => [],
    onLegacyParseError: () => {
      throw Error('Unexpected legacy projection');
    },
  });
  const responseOwner = { read: () => reader.getSessionTranscript(sessionId) };
  const fetch = vi.fn(async (url: string) =>
    url.includes('/messages')
      ? Response.json(
          new URL(url, 'http://offline.test').searchParams.has('throughSeq')
            ? reader.getReconnectTranscript(
                sessionId,
                Number(new URL(url, 'http://offline.test').searchParams.get('throughSeq')),
              )
            : await (url.includes(sessionId)
                ? responseOwner.read()
                : reader.getSessionTranscript('other-chat')),
        )
      : Response.json([]),
  );
  const store = createMitzoStore({
    transport: { fetch },
    sseConfig: { baseUrl: '', fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket() {
        throw Error('Inert SSE only');
      },
    },
  });
  await store.getState().switchSession(sessionId);
  return { sessionId, events, append, reader, fetch, responseOwner, store };
}

it.each(
  [false, true].flatMap((hasTool) =>
    ['foreground', 'bounded'].map((recovery) => ({ hasTool, recovery })),
  ),
)(
  'recovers missed live retractions through the canonical reader and store %j',
  async ({ hasTool, recovery }) => {
    const { sessionId, events, append, reader, store } = await fixture(hasTool);
    expect(JSON.stringify(store.getState().messages.messages)).toContain('OLD_OUTPUT');
    append('message_retracted', { sessionId, messageId: 'old' });
    if (hasTool) append('message_retracted', { sessionId, messageId: 'old', toolId: 'read' });
    const canonical = await reader.getSessionTranscript(sessionId);
    expect(JSON.stringify(canonical.messages)).not.toContain('OLD_OUTPUT');
    if (hasTool) expect(JSON.stringify(canonical.messages)).not.toContain('OLD_RESULT');
    channel.listener(
      recovery === 'foreground'
        ? { type: '_foreground' }
        : {
            type: 'session_reconnect_snapshot',
            sessionId,
            cursor: events.getSessionEvents(sessionId).at(-1)!.seq,
            cursorValid: true,
          },
    );
    await vi.waitFor(() =>
      expect(JSON.stringify(store.getState().messages.messages)).not.toContain('OLD_OUTPUT'),
    );
    if (hasTool) {
      expect(JSON.stringify(store.getState().messages.messages)).not.toContain('OLD_RESULT');
      expect(JSON.stringify(store.getState().messages.messages)).toContain('Read');
    }
    expect(JSON.stringify(store.getState().messages.messages)).toContain('Keep original input.');
    expect(JSON.stringify(events.getSessionEvents(sessionId))).toContain('OLD_OUTPUT');
  },
);

it('returns only receipts inside the selected immutable reconnect prefix', async () => {
  const { sessionId, append, events, reader } = await fixture(false);
  const before = events.getSessionEvents(sessionId).at(-1)!.seq;
  append('message_retracted', { sessionId, messageId: 'old' });
  const earlier = reader.getReconnectTranscript(sessionId, before);
  expect(JSON.stringify(earlier)).toContain('OLD_OUTPUT');
  expect(earlier).not.toHaveProperty('retractions');
  const current = reader.getReconnectTranscript(
    sessionId,
    events.getSessionEvents(sessionId).at(-1)!.seq,
  );
  expect(JSON.stringify(current.messages)).not.toContain('OLD_OUTPUT');
  expect(current).toHaveProperty('retractions', [{ messageId: 'old' }]);
});

it('retains a newer live suffix while applying canonical retraction receipts', async () => {
  const { sessionId, append, reader, responseOwner, store } = await fixture(false);
  append('message_retracted', { sessionId, messageId: 'old' });
  const prefix = await reader.getSessionTranscript(sessionId);
  let release!: (value: typeof prefix) => void;
  responseOwner.read = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  channel.listener({ type: '_foreground' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  channel.listener({ type: 'session_state_changed', sessionId, state: 'running' });
  channel.listener({ type: 'message_start', sessionId, messageId: 'newer' });
  channel.listener({
    type: 'block_start',
    sessionId,
    messageId: 'newer',
    blockId: 'new-text',
    blockType: 'text',
  });
  channel.listener({
    type: 'block_delta',
    sessionId,
    messageId: 'newer',
    blockId: 'new-text',
    blockType: 'text',
    delta: 'NEWER_LIVE_OUTPUT',
  });
  release(prefix);
  await vi.waitFor(() =>
    expect(JSON.stringify(store.getState().messages.messages)).not.toContain('OLD_OUTPUT'),
  );
  expect(store.getState().messages.current?.messageId).toBe('newer');
  expect(JSON.stringify([...store.getState().messages.current!.blocks.values()])).toContain(
    'NEWER_LIVE_OUTPUT',
  );
  expect(store.getState().messages.running).toBe(true);
});

it('does not resurrect output when an older REST response arrives after a live receipt', async () => {
  const { sessionId, reader, responseOwner, store } = await fixture(false);
  const stale = await reader.getSessionTranscript(sessionId);
  let release!: (value: typeof stale) => void;
  responseOwner.read = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  channel.listener({ type: '_foreground' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  channel.listener({ type: 'message_retracted', sessionId, messageId: 'old' });
  release(stale);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(() => expect(store.getState().historyLoading).toBe(false));
  await vi.waitFor(() =>
    expect(JSON.stringify(store.getState().messages.messages)).not.toContain('OLD_OUTPUT'),
  );
});

it('keeps known tool activity when sequenced live receipts overlap an older REST prefix', async () => {
  const { sessionId, reader, responseOwner, store } = await fixture(true);
  const stale = await reader.getSessionTranscript(sessionId);
  let release!: (value: typeof stale) => void;
  responseOwner.read = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  channel.listener({ type: '_foreground' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  channel.listener({
    type: 'message_retracted',
    sessionId,
    messageId: 'old',
    seq: stale.cursor! + 1,
  });
  channel.listener({
    type: 'message_retracted',
    sessionId,
    messageId: 'old',
    toolId: 'read',
    seq: stale.cursor! + 2,
  });
  release(stale);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(() => expect(store.getState().historyLoading).toBe(false));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(JSON.stringify(store.getState().messages.messages)).toContain('Read');
  expect(JSON.stringify(store.getState().messages.messages)).not.toContain('OLD_RESULT');
  expect(JSON.stringify(store.getState().messages.messages)).not.toContain('OLD_OUTPUT');
});

it('does not preserve a stale streaming copy merely because its blocks were retracted during refresh', async () => {
  const { sessionId, append, store } = await fixture(true);
  store.setState((s) => ({
    messages: { ...s.messages, messages: s.messages.messages.filter((m) => m.messageId !== 'old') },
  }));
  channel.listener({ type: 'message_start', sessionId, messageId: 'old' });
  channel.listener({
    type: 'block_start',
    sessionId,
    messageId: 'old',
    blockId: 'tool',
    blockType: 'tool_use',
    toolId: 'read',
    toolName: 'Read',
  });
  channel.listener({
    type: 'block_end',
    sessionId,
    messageId: 'old',
    blockId: 'tool',
    blockType: 'tool_use',
    toolId: 'read',
    toolName: 'Read',
  });
  expect(store.getState().messages.current?.messageId).toBe('old');
  append('message_retracted', { sessionId, messageId: 'old' });
  append('message_retracted', { sessionId, messageId: 'old', toolId: 'read' });
  channel.listener({ type: '_foreground' });
  await vi.waitFor(() => expect(store.getState().messages.current).toBeNull());
  expect(store.getState().messages.messages.filter((m) => m.messageId === 'old')).toHaveLength(1);
  expect(JSON.stringify(store.getState().messages.messages)).toContain('Read');
});

it.each([
  { newOutput: false, lateAction: 'none' },
  { newOutput: true, lateAction: 'none' },
  { newOutput: false, lateAction: 'tool_result' },
  { newOutput: false, lateAction: 'block_delta' },
])(
  'retains canonical activity through incremental replay %j',
  async ({ newOutput, lateAction }) => {
    const { sessionId, append, reader, responseOwner, store } = await fixture(true);
    store.setState((s) => ({
      messages: {
        ...s.messages,
        messages: s.messages.messages.filter((m) => m.messageId !== 'old'),
      },
    }));
    channel.listener({ type: 'message_start', sessionId, messageId: 'old' });
    for (const type of ['block_start', 'block_end'])
      channel.listener({
        type,
        sessionId,
        messageId: 'old',
        blockId: 'tool',
        blockType: 'tool_use',
        toolId: 'read',
        toolName: 'Read',
      });
    const prefix = await reader.getSessionTranscript(sessionId);
    let release!: (value: typeof prefix) => void;
    responseOwner.read = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    channel.listener({ type: '_foreground' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const receipt = { sessionId, messageId: 'old' };
    const receiptSeq = append('message_retracted', receipt);
    channel.listener({ type: 'message_retracted', ...receipt, seq: receiptSeq });
    const metadata = { messageId: 'input', commandState: 'completed' };
    const metadataSeq = append('ordinary_command_state', metadata);
    expect(metadataSeq).toBe(receiptSeq + 1);
    channel.listener({ type: 'ordinary_command_state', sessionId, ...metadata, seq: metadataSeq });
    if (lateAction !== 'none') {
      const payload =
        lateAction === 'tool_result'
          ? { messageId: 'old', toolId: 'read', result: 'NEW_RESULT' }
          : { messageId: 'old', blockId: 'text', blockType: 'text', delta: 'STALE_RETRACTED_TEXT' };
      const seq = append(lateAction, payload);
      channel.listener({ type: lateAction, sessionId, ...payload, seq });
      if (lateAction === 'tool_result')
        expect(JSON.stringify([...store.getState().messages.current!.blocks.values()])).toContain(
          'NEW_RESULT',
        );
    }
    if (newOutput) {
      channel.listener({ type: 'message_start', sessionId, messageId: 'new-output' });
      channel.listener({
        type: 'block_start',
        sessionId,
        messageId: 'new-output',
        blockId: 'new-text',
        blockType: 'text',
      });
      channel.listener({
        type: 'block_delta',
        sessionId,
        messageId: 'new-output',
        blockId: 'new-text',
        delta: 'NEW LIVE OUTPUT',
      });
    }
    release(prefix);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.waitFor(() => expect(store.getState().historyLoading).toBe(false));
    expect(store.getState().historyError).toBeNull();
    if (newOutput) {
      expect(store.getState().messages.current?.messageId).toBe('new-output');
      expect(
        JSON.stringify(Array.from(store.getState().messages.current!.blocks.values())),
      ).toContain('NEW LIVE OUTPUT');
    } else expect(store.getState().messages.current).toBeNull();
    expect(store.getState().messages.messages.filter((m) => m.messageId === 'old')).toHaveLength(1);
    expect(JSON.stringify(store.getState().messages.messages)).toContain('Read');
    if (lateAction === 'tool_result')
      expect(JSON.stringify(store.getState().messages.messages)).toContain('NEW_RESULT');
    expect(JSON.stringify(store.getState().messages.messages)).not.toContain(
      'STALE_RETRACTED_TEXT',
    );
    expect(store.getState().messages.commandStates?.input).toBe('completed');
  },
);

it('ignores a retraction response after the selected conversation changes', async () => {
  const { sessionId, append, reader, responseOwner, store } = await fixture(false);
  append('message_retracted', { sessionId, messageId: 'old' });
  const prefix = await reader.getSessionTranscript(sessionId);
  let release!: (value: typeof prefix) => void;
  responseOwner.read = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  channel.listener({ type: '_foreground' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await store.getState().switchSession('other-chat');
  release(prefix);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(store.getState().sessions.active).toBe('other-chat');
  expect(store.getState().messages.messageRetractions).toBeUndefined();
});

it.each([
  null,
  {},
  { messageId: 'old', seatId: 'seat' },
  { messageId: 'old', symposiumProvenance: {} },
])('retains known output and exposes malformed canonical receipt failure %j', async (target) => {
  const { reader, responseOwner, store } = await fixture(false);
  const prefix = await reader.getSessionTranscript('selected-chat');
  responseOwner.read = async () => ({ ...prefix, retractions: [target] }) as never;
  channel.listener({ type: '_foreground' });
  await vi.waitFor(() => expect(store.getState().historyError).toContain('Could not restore'));
  expect(JSON.stringify(store.getState().messages.messages)).toContain('OLD_OUTPUT');
});
