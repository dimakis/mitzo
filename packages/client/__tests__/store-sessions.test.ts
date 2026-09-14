import { describe, it, expect, vi } from 'vitest';
import { createMitzoStore } from '../src/store.js';
import type { MitzoStoreOptions } from '../src/store.js';
import type { TransportAdapter } from '../src/types.js';
import type { WebSocketLike } from '../src/ws-connection.js';
import { WS_READY_STATE } from '../src/types.js';

// ─── Mock transport ─────────────────────────────────────────────────────────

class MockWebSocket implements WebSocketLike {
  readyState = WS_READY_STATE.OPEN;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = WS_READY_STATE.CLOSED;
  }
}

function mockTransport(): TransportAdapter {
  return {
    connectWs: vi.fn(),
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(''),
    }),
  };
}

function makeOptions(transport?: TransportAdapter): MitzoStoreOptions {
  return {
    transport: transport ?? mockTransport(),
    wsConfig: {
      buildUrl: () => 'ws://localhost:3000/ws',
      createWebSocket: () => new MockWebSocket(),
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadSessions', () => {
  it('sets loading=true then false, populates list on success', async () => {
    const transport = mockTransport();
    const sessions = [
      { sessionId: 's1', name: 'Session 1', createdAt: 1000, updatedAt: 2000 },
      { sessionId: 's2', name: 'Session 2', createdAt: 1001, updatedAt: 2001 },
    ];
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sessions),
      text: () => Promise.resolve(''),
    });

    const store = createMitzoStore(makeOptions(transport));

    const promise = store.getState().loadSessions();

    // loading should be true while in-flight
    expect(store.getState().sessions.loading).toBe(true);

    await promise;

    expect(store.getState().sessions.loading).toBe(false);
    expect(store.getState().sessions.list).toHaveLength(2);
    expect(store.getState().sessions.list[0].sessionId).toBe('s1');
  });

  it('resets loading on failure and preserves empty list', async () => {
    const transport = mockTransport();
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('fail')),
      text: () => Promise.resolve('Internal Server Error'),
    });

    const store = createMitzoStore(makeOptions(transport));
    await store.getState().loadSessions();

    expect(store.getState().sessions.loading).toBe(false);
    expect(store.getState().sessions.list).toHaveLength(0);
  });
});

describe('refreshSessions', () => {
  it('updates list silently on success', async () => {
    const transport = mockTransport();
    const sessions = [{ sessionId: 's1', name: 'Refreshed', createdAt: 1000, updatedAt: 3000 }];
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sessions),
      text: () => Promise.resolve(''),
    });

    const store = createMitzoStore(makeOptions(transport));
    await store.getState().refreshSessions();

    expect(store.getState().sessions.list).toHaveLength(1);
    expect(store.getState().sessions.list[0].name).toBe('Refreshed');
  });

  it('keeps existing list on failure', async () => {
    const transport = mockTransport();

    // First load succeeds
    const sessions = [{ sessionId: 's1', name: 'Existing', createdAt: 1000, updatedAt: 2000 }];
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sessions),
      text: () => Promise.resolve(''),
    });

    const store = createMitzoStore(makeOptions(transport));
    await store.getState().loadSessions();
    expect(store.getState().sessions.list).toHaveLength(1);

    // Refresh fails
    (transport.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('fail')),
      text: () => Promise.resolve('error'),
    });

    await store.getState().refreshSessions();

    // List preserved
    expect(store.getState().sessions.list).toHaveLength(1);
    expect(store.getState().sessions.list[0].name).toBe('Existing');
  });
});

describe('delivery status on navigation', () => {
  it.each(['switch', 'new'])('clears the previous conversation error on %s', async (action) => {
    const store = createMitzoStore(makeOptions());
    store.setState({ sendError: 'Reconnecting — your message will retry automatically.' });
    if (action === 'switch') await store.getState().switchSession('other');
    else store.getState().newSession();
    expect(store.getState().sendError).toBeNull();
  });
});

describe('conversation history selection', () => {
  function deferredHistory() {
    const transport = mockTransport();
    const pending: Array<(response: unknown) => void> = [];
    vi.mocked(transport.fetch).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const store = createMitzoStore(makeOptions(transport));
    const finish = (index: number, id: string | string[]) =>
      pending[index]({
        ok: true,
        json: async () =>
          (Array.isArray(id) ? id : [id]).map((messageId) => ({
            messageId,
            role: 'assistant',
            blocks: [{ type: 'text', text: messageId }],
          })),
      });
    return { store, finish };
  }

  it('keeps the selected transcript when an earlier fetch finishes last', async () => {
    const { store, finish } = deferredHistory();
    const first = store.getState().switchSession('first');
    const second = store.getState().switchSession('second');
    expect(store.getState().historyLoading).toBe(true);
    finish(1, 'second-response');
    await second;
    finish(0, 'first-response');
    await first;
    expect(store.getState().sessions.active).toBe('second');
    expect(store.getState().messages.messages.map((m) => m.messageId)).toEqual(['second-response']);
    expect(store.getState().historyLoading).toBe(false);
  });

  it('does not restore a previous conversation into a new chat', async () => {
    const { store, finish } = deferredHistory();
    const first = store.getState().switchSession('first');
    store.getState().newSession();
    finish(0, 'first-response');
    await first;
    expect(store.getState().sessions.active).toBeNull();
    expect(store.getState().messages.messages).toEqual([]);
    expect(store.getState().historyLoading).toBe(false);
  });
  it.each([false, true])(
    'keeps live messages and a running turn when older history arrives (overlap: %s)',
    async (overlap) => {
      const { store, finish } = deferredHistory();
      const load = store.getState().switchSession('second');
      const dispatch = store.getState().dispatchMessages;
      dispatch({ type: 'USER_MESSAGE_RECEIVED', messageId: 'live-user', text: 'new turn' });
      dispatch({ type: 'MESSAGE_START', messageId: 'live-assistant' });
      dispatch({ type: 'MESSAGE_END', messageId: 'live-assistant' });
      dispatch({ type: 'MESSAGE_START', messageId: 'still-streaming' });
      store.setState((s) => ({ messages: { ...s.messages, running: true } }));
      const runningBefore = store.getState().messages.running;
      finish(
        0,
        overlap
          ? ['older-history', 'live-user', 'live-assistant', 'still-streaming']
          : ['older-history'],
      );
      await load;
      expect(store.getState().messages.messages.map((m) => m.messageId)).toEqual([
        'older-history',
        'live-user',
        'live-assistant',
      ]);
      expect(store.getState().messages.current?.messageId).toBe('still-streaming');
      expect(store.getState().messages.running).toBe(runningBefore);
    },
  );
});
