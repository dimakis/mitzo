// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createMitzoStore } from '@mitzo/client';
import type { WebSocketLike } from '@mitzo/client';
import { WS_READY_STATE } from '@mitzo/client';
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: vi.fn(() => vi.fn()),
    onConnectionChange: vi.fn(() => vi.fn()),
    connected: false,
  },
}));

import { useTabBadges } from '../useTabBadges';

class MockWebSocket implements WebSocketLike {
  readyState: number = WS_READY_STATE.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  simulateOpen() {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.({});
  }
  simulateMessage(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let lastWs: MockWebSocket;

function setup() {
  const store = createMitzoStore({
    transport: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      }),
    },
    wsConfig: {
      buildUrl: () => 'ws://localhost/ws',
      createWebSocket: () => {
        lastWs = new MockWebSocket();
        return lastWs;
      },
    },
  });

  lastWs.simulateOpen();
  lastWs.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'c1' });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MitzoStoreProvider, { value: store }, children);

  return { store, wrapper };
}

describe('useTabBadges', () => {
  afterEach(cleanup);

  it('returns inboxCount from the store', async () => {
    const { wrapper, store } = setup();

    // Directly set inbox state
    store.setState({
      inbox: { items: [{ filename: 'a' }, { filename: 'b' }] as never[], count: 2 },
    });

    const { result } = renderHook(() => useTabBadges(), { wrapper });

    await waitFor(() => {
      expect(result.current.inboxCount).toBe(2);
    });
  });

  it('returns todoCount filtering completed items', async () => {
    const { wrapper, store } = setup();

    store.setState({
      todos: {
        items: [
          { id: 'a', status: 'active' } as never,
          { id: 'b', status: 'completed' } as never,
          { id: 'c', status: 'acknowledged' } as never,
        ],
        profiles: [],
      },
    });

    const { result } = renderHook(() => useTabBadges(), { wrapper });

    await waitFor(() => {
      expect(result.current.todoCount).toBe(2);
    });
  });
});
