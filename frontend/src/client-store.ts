/**
 * Bootstrap @mitzo/client store for the browser environment.
 *
 * This creates a MitzoStore with browser-native WebSocket and fetch.
 * Currently wired in for integration testing — the existing hooks
 * continue to drive the UI. This will become the primary state layer
 * once the frontend migration is complete.
 */

import { createMitzoStore } from '@mitzo/client';

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${proto}://${location.host}/ws/chat`;

export const clientStore = createMitzoStore({
  transport: {
    connectWs(url, handlers) {
      const ws = new WebSocket(url);
      ws.onopen = () => handlers.onOpen();
      ws.onmessage = (e) => handlers.onMessage(e.data);
      ws.onclose = () => handlers.onClose();
      ws.onerror = (e) => handlers.onError(e);
      return {
        send: (data: string) => ws.send(data),
        close: () => ws.close(),
        get readyState() { return ws.readyState; },
      };
    },
    fetch: (url, init) => fetch(url, init),
  },
  wsConfig: {
    buildUrl: () => wsUrl,
    createWebSocket: (url) => new WebSocket(url) as import('@mitzo/client').WebSocketLike,
    reconnectDelayMs: 500,
    reconnectPollMs: 5_000,
  },
});

// Expose on window for console debugging during testing
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__mitzoStore = clientStore;
}
