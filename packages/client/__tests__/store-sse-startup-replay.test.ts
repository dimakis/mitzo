import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../src/store.js';

it.each([
  ['local', 'snapshot-first'],
  ['openshell', 'snapshot-first'],
  ['local', 'receipt-first'],
  ['openshell', 'receipt-first'],
  ['local', 'newer-offer'],
  ['openshell', 'newer-offer'],
  ['local', 'ack-pending'],
  ['openshell', 'ack-pending'],
  ['local', 'history-pending'],
  ['openshell', 'history-pending'],
] as const)('streams %s startup exactly once when %s completes first', async (runOn, order) => {
  let welcome!: (event: MessageEvent) => void;
  const source = {
    readyState: 1,
    addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'welcome') welcome = listener;
    }),
    removeEventListener: vi.fn(),
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null,
  };
  const emit = (data: Record<string, unknown>) =>
    source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  let accept!: (response: Response) => void;
  let restore!: (response: Response) => void;
  let acknowledge!: (response: Response) => void;
  let history!: (response: Response) => void;
  const transcript = (content: string, cursor: number) => ({
    messages: [],
    cursor,
    current: {
      messageId: 'reply',
      startedSeq: 2,
      blocks: [{ blockId: 'text', blockType: 'text', content, done: false }],
    },
  });
  const acceptReceipt = () =>
    accept(
      Response.json(
        {
          ok: true,
          clientMsgId: 'startup',
          sessionId: 'chat',
          dispatched: true,
          state: 'consumed',
        },
        { status: 202 },
      ),
    );
  const fetch = vi.fn((url: string, _init?: RequestInit) => {
    if (
      (order === 'ack-pending' || order === 'history-pending') &&
      url.endsWith('/reconnect-snapshot-applied')
    )
      return new Promise<Response>((resolve) => {
        acknowledge = resolve;
      });
    if (url === '/local/send' || url === '/api/chat/runtime/send')
      return new Promise<Response>((resolve) => {
        accept = resolve;
      });
    if (url.includes('throughSeq=5'))
      return new Promise<Response>((resolve) => {
        restore = resolve;
      });
    if (order === 'history-pending' && url.includes('/messages'))
      return new Promise<Response>((resolve) => {
        history = resolve;
      });
    if (url.includes('/messages'))
      return Promise.resolve(
        Response.json(
          order !== 'snapshot-first'
            ? transcript('PrefixSuffix', 6)
            : { messages: [], current: null, cursor: 5 },
        ),
      );
    return Promise.resolve(Response.json(url.includes('/api/chat/') ? { applied: true } : []));
  });
  let saved = '[]';
  const store = createMitzoStore({
    transport: { fetch, connectWs: vi.fn() },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('SSE only');
      },
    },
    sseConfig: { baseUrl: '', fetch, createEventSource: () => source as unknown as EventSource },
    localFirstCommandConfig: {
      url: '/local/send',
      storage: {
        getItem: () => saved,
        setItem: (_, value) => {
          saved = value;
        },
      },
    },
  });
  const assigned = vi.fn();
  const delivered = vi.fn();
  try {
    welcome(new MessageEvent('welcome', { data: JSON.stringify({ connectionId: 'browser' }) }));
    expect(
      store.getState().sendLocalFirstCommand(
        {
          runOn,
          repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
          clientMsgId: 'startup',
          capabilityRevision: 'caps-r1',
          runtime: {
            account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'r1' },
            harness: 'codex',
            targetId: 'mac',
            mode: 'agent',
          },
          selection: {
            version: 1,
            agent: { profileId: 'agent', revision: 1 },
            model: 'luna-fixture',
            thinking: 'low',
            context: { source: 'none', revision: null },
            permission: { mode: 'agent', revision: 0 },
          },
          payload: { text: 'Inspect' },
        },
        { draftId: 'draft', onSessionAssigned: assigned, onDelivery: delivered },
      ),
    ).toBe(true);
    emit({ type: 'session_id', sessionId: 'chat', clientMsgId: 'startup' });
    emit({
      type: 'user_message',
      sessionId: 'chat',
      messageId: 'startup',
      text: 'Inspect',
      seq: 1,
      prevSessionSeq: 0,
    });
    // The stream reconnects during the original HTTP send, after observing
    // its correlated echo but before the receipt may adopt the chat.
    welcome(new MessageEvent('welcome', { data: JSON.stringify({ connectionId: 'reconnected' }) }));
    emit({
      type: 'session_reconnect_snapshot',
      sessionId: 'chat',
      cursor: 5,
      cursorValid: true,
      offerId: 'startup-offer',
      state: 'running',
    });
    await vi.waitFor(() => expect(restore).toBeTypeOf('function'));
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/reconnect-snapshot-applied'))).toBe(
      false,
    );
    if (order === 'ack-pending' || order === 'history-pending') {
      restore(Response.json(transcript('Prefix', 5)));
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
      emit({
        type: 'block_delta',
        sessionId: 'chat',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
        delta: 'Suffix',
        seq: 6,
        prevSessionSeq: 5,
      });
      acceptReceipt();
      if (order === 'history-pending') {
        await vi.waitFor(() => expect(history).toBeTypeOf('function'));
        expect(store.getState().sessions.active).toBe('chat');
      } else {
        await vi.waitFor(() =>
          expect(store.getState().messages.current?.blocks.get('text')?.content).toBe(
            'PrefixSuffix',
          ),
        );
      }
      acknowledge(Response.json({ applied: true }));
      // ACK confirmation is asynchronous; a duplicate would appear only after it resolves.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (order === 'history-pending') {
        history(Response.json(transcript('PrefixSuffix', 6)));
        await vi.waitFor(() =>
          expect(store.getState().messages.current?.blocks.get('text')?.content).toBe(
            'PrefixSuffix',
          ),
        );
      }
      expect(store.getState().messages.current?.blocks.get('text')?.content).toBe('PrefixSuffix');
      emit({
        type: 'block_delta',
        sessionId: 'chat',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
        delta: 'Next',
        seq: 7,
        prevSessionSeq: 6,
      });
      expect(store.getState().messages.current?.blocks.get('text')?.content).toBe(
        'PrefixSuffixNext',
      );
      expect(source.close).not.toHaveBeenCalled();
      return;
    }
    if (order !== 'snapshot-first') {
      emit({
        type: 'block_delta',
        sessionId: 'chat',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
        delta: 'Suffix',
        seq: 6,
        prevSessionSeq: 5,
      });
      acceptReceipt();
      await vi.waitFor(() =>
        expect(store.getState().messages.current?.blocks.get('text')?.content).toBe('PrefixSuffix'),
      );
      if (order === 'newer-offer') {
        emit({
          type: 'session_reconnect_snapshot',
          sessionId: 'chat',
          cursor: 6,
          cursorValid: true,
          offerId: 'newer-offer',
          state: 'running',
        });
        await vi.waitFor(() =>
          expect(
            fetch.mock.calls.some(
              ([url, init]) =>
                url.endsWith('/reconnect-snapshot-applied') &&
                JSON.parse(String(init?.body)).offerId === 'newer-offer',
            ),
          ).toBe(true),
        );
        restore(Response.json(transcript('Prefix', 5)));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(
          fetch.mock.calls.filter(
            ([url, init]) =>
              url.endsWith('/reconnect-snapshot-applied') &&
              JSON.parse(String(init?.body)).offerId === 'startup-offer',
          ),
        ).toHaveLength(0);
        expect(store.getState().messages.current?.blocks.get('text')?.content).toBe('PrefixSuffix');
      } else {
        restore(Response.json(transcript('Prefix', 5)));
        await vi.waitFor(() =>
          expect(
            fetch.mock.calls.some(([url]) => url.endsWith('/reconnect-snapshot-applied')),
          ).toBe(true),
        );
        await vi.waitFor(() => expect(store.getState().historyLoading).toBe(false));
        expect(store.getState().messages.current?.blocks.get('text')?.content).toBe('PrefixSuffix');
      }
      emit({
        type: 'block_delta',
        sessionId: 'chat',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
        delta: 'Next',
        seq: 7,
        prevSessionSeq: 6,
      });
      expect(store.getState().messages.current?.blocks.get('text')?.content).toBe(
        'PrefixSuffixNext',
      );
      expect(fetch.mock.calls.filter(([url]) => url.includes('throughSeq=5'))).toHaveLength(1);
      expect(source.close).not.toHaveBeenCalled();
      return;
    }
    restore(Response.json({ messages: [], current: null, cursor: 5 }));
    await vi.waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => url.endsWith('/reconnect-snapshot-applied'))).toBe(
        true,
      ),
    );
    const ack = fetch.mock.calls.find(([url]) => url.endsWith('/reconnect-snapshot-applied'))!;
    expect(JSON.parse(String(ack[1]?.body))).toMatchObject({
      sessionId: 'chat',
      cursor: 5,
      offerId: 'startup-offer',
    });
    expect(store.getState().sessions.active).toBeNull();
    expect(assigned).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalledWith('accepted');
    accept(
      Response.json(
        {
          ok: true,
          clientMsgId: 'startup',
          sessionId: 'chat',
          dispatched: true,
          state: 'consumed',
        },
        { status: 202 },
      ),
    );
    await vi.waitFor(() => expect(store.getState().sessions.active).toBe('chat'));
    await vi.waitFor(() => expect(store.getState().historyLoading).toBe(false));
    // Use the actual SSE ordering implementation: an unreleased offer buffers these.
    emit({
      type: 'message_start',
      sessionId: 'chat',
      messageId: 'reply',
      seq: 6,
      prevSessionSeq: 5,
    });
    emit({
      type: 'block_start',
      sessionId: 'chat',
      messageId: 'reply',
      blockId: 'text',
      blockType: 'text',
      seq: 7,
      prevSessionSeq: 6,
    });
    emit({
      type: 'block_delta',
      sessionId: 'chat',
      messageId: 'reply',
      blockId: 'text',
      delta: 'Immediate output',
      seq: 8,
      prevSessionSeq: 7,
    });
    expect(store.getState().messages.current?.blocks.get('text')?.content).toBe('Immediate output');
    expect(source.close).not.toHaveBeenCalled();
  } finally {
    store.getState().invalidateAuthentication();
  }
});
