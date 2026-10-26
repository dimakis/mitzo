import { describe, expect, it, vi } from 'vitest';
import { createMitzoStore } from '../src/store.js';

describe('SSE launch handoff', () => {
  it.each(['before', 'after'])(
    'attaches a headerless first send when welcome arrives %s acceptance',
    async (welcomeTiming) => {
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
      let accept!: (response: Response) => void;
      let command!: { clientMsgId: string; sessionId: string | null };
      const fetch = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/send')) {
          command = JSON.parse(String(init?.body));
          if (command.sessionId === null)
            expect(init?.headers).not.toHaveProperty('X-Connection-ID');
          else expect(init?.headers).toHaveProperty('X-Connection-ID', 'browser');
          return new Promise<Response>((resolve) => {
            accept = resolve;
          });
        }
        return Promise.resolve(Response.json({ applied: true }));
      });
      const store = createMitzoStore({
        transport: { fetch: vi.fn(() => Promise.resolve(Response.json([]))), connectWs: vi.fn() },
        wsConfig: {
          buildUrl: () => '',
          createWebSocket: () => {
            throw new Error('SSE only');
          },
        },
        sseConfig: {
          baseUrl: '',
          fetch,
          createEventSource: () => source as unknown as EventSource,
        },
      });
      try {
        store.getState().sendMessage('first prompt', { onDelivery: vi.fn() });
        const emitWelcome = () =>
          welcome(
            new MessageEvent('welcome', { data: JSON.stringify({ connectionId: 'browser' }) }),
          );
        if (welcomeTiming === 'before') emitWelcome();
        accept(
          Response.json({ accepted: true, clientMsgId: command.clientMsgId, sessionId: 'new' }),
        );
        await vi.waitFor(() => expect(store.getState().sessions.active).toBe('new'));
        if (welcomeTiming === 'after') emitWelcome();
        // Local session assignment is not proof that the server attached the stream.
        await vi.waitFor(() =>
          expect(fetch.mock.calls.filter(([url]) => url.endsWith('/reconnect'))).toHaveLength(1),
        );
        const [, reconnect] = fetch.mock.calls.find(([url]) => url.endsWith('/reconnect'))!;
        expect(JSON.parse(String(reconnect?.body)).sessions).toEqual([
          { sessionId: 'new', lastSeq: 0, subscriptionId: expect.any(String) },
        ]);
        source.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'message_start',
              sessionId: 'new',
              messageId: 'answer',
              seq: 1,
              prevSessionSeq: 0,
            }),
          }),
        );
        source.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'session_reconnect_snapshot',
              sessionId: 'new',
              cursor: 0,
              cursorValid: true,
            }),
          }),
        );
        await vi.waitFor(() => expect(store.getState().messages.current?.messageId).toBe('answer'));
        for (const event of [
          { type: 'block_start', blockId: 'text', blockType: 'text', seq: 2 },
          { type: 'block_delta', blockId: 'text', delta: 'Live answer without refresh', seq: 3 },
          { type: 'block_end', blockId: 'text', seq: 4 },
          { type: 'message_end', seq: 5 },
        ]) {
          source.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                ...event,
                sessionId: 'new',
                messageId: 'answer',
                prevSessionSeq: event.seq - 1,
              }),
            }),
          );
        }
        expect(
          store.getState().messages.messages.find((m) => m.messageId === 'answer')?.blocks[0]
            .content,
        ).toBe('Live answer without refresh');
        const followupDelivery = vi.fn();
        store.getState().sendMessage('follow-up', { onDelivery: followupDelivery });
        accept(
          Response.json({ accepted: true, clientMsgId: command.clientMsgId, sessionId: 'new' }),
        );
        await vi.waitFor(() => expect(followupDelivery).toHaveBeenCalledWith('accepted'));
        expect(fetch.mock.calls.filter(([url]) => url.endsWith('/reconnect'))).toHaveLength(1);
        expect(source.close).not.toHaveBeenCalled();
      } finally {
        store.getState().invalidateAuthentication();
      }
    },
  );
});
