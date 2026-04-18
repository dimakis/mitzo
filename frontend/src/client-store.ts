/**
 * Bootstrap @mitzo/client store for the browser environment.
 *
 * This creates a MitzoStore with browser-native WebSocket and fetch.
 * Currently wired in for integration testing — the existing hooks
 * continue to drive the UI. This will become the primary state layer
 * once the frontend migration is complete.
 */

import { createMitzoStore } from '@mitzo/client';
import { apiFetch, getWsChatUrl } from './lib/api-fetch';
import { registerCapacitorLifecycle } from './lib/capacitor';

export const clientStore = createMitzoStore({
  transport: {
    fetch: (url, init) => apiFetch(url, init),
  },
  wsConfig: {
    buildUrl: () => getWsChatUrl(),
    createWebSocket: (url) => new WebSocket(url) as import('@mitzo/client').WebSocketLike,
    reconnectDelayMs: 500,
  },
});

// Wire Capacitor app lifecycle → force WS reconnect on resume (no-op in browser)
registerCapacitorLifecycle(() => clientStore.getState().forceReconnect());

// Expose on window for console debugging during testing
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__mitzoStore = clientStore;
}
