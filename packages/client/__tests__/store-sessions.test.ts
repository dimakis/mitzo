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
