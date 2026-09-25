// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
import type { WebSocketLike } from '../ws-connection.js';

it('publishes connection ID changes in store state even while status remains connected', () => {
  const socket: WebSocketLike = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  };
  const store = createMitzoStore({
    transport: { fetch: vi.fn() },
    wsConfig: { buildUrl: () => '/ws/chat', createWebSocket: () => socket },
  });
  socket.onopen?.({});
  socket.onmessage?.({
    data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'first' }),
  });
  expect(store.getState().connection).toMatchObject({ status: 'connected', clientId: 'first' });

  socket.onmessage?.({
    data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'second' }),
  });
  expect(store.getState().connection).toMatchObject({ status: 'connected', clientId: 'second' });
});
