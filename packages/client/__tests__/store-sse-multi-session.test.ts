import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../src/store.js';

it.each(['selected', 'draft'] as const)(
  'discards a retired background snapshot and suffix while viewing %s without reconnecting',
  async (view) => {
    let welcome!: (event: MessageEvent) => void;
    const source = {
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
        if (type === 'welcome') welcome = listener;
      }),
      close: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
    };
    const createEventSource = vi.fn(() => source as unknown as EventSource);
    let accept!: (response: Response) => void;
    const delivered = vi.fn();
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/send'))
        return new Promise<Response>((resolve) => {
          accept = resolve;
        });
      if (url.includes('/messages'))
        return Response.json({ messages: [], current: null, cursor: 10 });
      return Response.json(url.includes('/api/chat/') ? { applied: true } : []);
    });
    const store = createMitzoStore({
      transport: { fetch, connectWs: vi.fn() },
      wsConfig: {
        buildUrl: () => '',
        createWebSocket: () => {
          throw Error('SSE only');
        },
      },
      sseConfig: { baseUrl: '', fetch, createEventSource },
    });
    const emit = (data: Record<string, unknown>) =>
      source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
    try {
      welcome(
        new MessageEvent('welcome', {
          data: JSON.stringify({ connectionId: 'browser', eventAckBatchSize: 50 }),
        }),
      );
      await store.getState().switchSession('background');
      store.getState().sendMessage('Background prompt', { onDelivery: delivered });
      const id = store.getState().messages.messages.at(-1)!.messageId;
      await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
      await store.getState().switchSession('selected');
      accept(
        Response.json(
          { accepted: true, clientMsgId: id, sessionId: 'background' },
          { status: 202 },
        ),
      );
      await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('accepted'));
      if (view === 'draft') store.getState().newSession();
      const selected = store.getState().messages;
      const active = store.getState().sessions.active;
      emit({
        type: 'session_reconnect_snapshot',
        sessionId: 'background',
        cursor: 10,
        offerId: 'offer-1',
        state: 'idle',
      });
      emit({
        type: 'message_start',
        sessionId: 'background',
        seq: 11,
        prevSessionSeq: 10,
        messageId: 'background-reply',
      });
      emit({
        type: 'block_start',
        sessionId: 'background',
        seq: 12,
        prevSessionSeq: 11,
        blockId: 'text',
        blockType: 'text',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        fetch.mock.calls.some(([url]) => url.includes('/background/messages?throughSeq=')),
      ).toBe(false);
      expect(fetch.mock.calls.some(([url]) => url.endsWith('/reconnect-snapshot-applied'))).toBe(
        false,
      );
      expect(store.getState().sessions.active).toBe(active);
      expect(store.getState().messages).toBe(selected);
      expect(source.close).not.toHaveBeenCalled();
      expect(createEventSource).toHaveBeenCalledTimes(1);
    } finally {
      store.getState().invalidateAuthentication();
    }
  },
);
