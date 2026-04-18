/**
 * Bootstrap @mitzo/client store for the browser environment.
 *
 * This creates a MitzoStore with browser-native WebSocket and fetch.
 * Currently wired in for integration testing — the existing hooks
 * continue to drive the UI. This will become the primary state layer
 * once the frontend migration is complete.
 */

import { createMitzoStore } from '@mitzo/client';
import { apiFetch, getWsBaseUrl } from './lib/api-fetch';

const wsUrl = `${getWsBaseUrl()}/ws/chat`;

export const clientStore = createMitzoStore({
  transport: {
    fetch: (url, init) => apiFetch(url, init),
  },
  wsConfig: {
    buildUrl: () => wsUrl,
    createWebSocket: (url) => new WebSocket(url) as import('@mitzo/client').WebSocketLike,
    reconnectDelayMs: 500,
  },
});

// Expose on window for console debugging during testing
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__mitzoStore = clientStore;
}
