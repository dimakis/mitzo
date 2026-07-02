/**
 * Bootstrap @mitzo/client store for the browser environment.
 *
 * This creates a MitzoStore with browser-native WebSocket and fetch.
 * Currently wired in for integration testing — the existing hooks
 * continue to drive the UI. This will become the primary state layer
 * once the frontend migration is complete.
 */

import { createMitzoStore } from '@mitzo/client';
import type { SseConnectionConfig } from '@mitzo/client';
import { apiFetch, getApiBaseUrl, getWsChatUrl } from './lib/api-fetch';
import { registerCapacitorLifecycle } from './lib/capacitor';
import { configureKeyboard } from './lib/keyboard';
import { initPushNotifications } from './lib/push';
import { eventBus } from './lib/event-bus-singleton';
import { getPreferredModel } from './lib/model-preference';

/**
 * Transport selector — SSE + HTTP POST is the default transport (Transport SSOT P0).
 * Set localStorage 'mitzo:transport' to 'ws' to fall back to WebSocket.
 *
 * Force WS:   localStorage.setItem('mitzo:transport', 'ws'); location.reload();
 * Revert SSE: localStorage.removeItem('mitzo:transport'); location.reload();
 */
const useSSE = typeof window !== 'undefined' && localStorage.getItem('mitzo:transport') !== 'ws';

const sseConfig: SseConnectionConfig | undefined = useSSE
  ? {
      baseUrl: getApiBaseUrl(),
      fetch: (url, init) => apiFetch(url, init),
      suspendUrl: `${getApiBaseUrl()}/api/sessions/suspend`,
    }
  : undefined;

export const clientStore = createMitzoStore({
  transport: {
    fetch: (url, init) => apiFetch(url, init),
  },
  wsConfig: {
    buildUrl: () => getWsChatUrl(),
    createWebSocket: (url) => new WebSocket(url) as import('@mitzo/client').WebSocketLike,
    reconnectDelayMs: 500,
    suspendUrl: `${getApiBaseUrl()}/api/sessions/suspend`,
  },
  ...(sseConfig ? { sseConfig } : {}),
});

// Sync localStorage model preference into the store so sendMessage() includes it
if (typeof window !== 'undefined') {
  clientStore.getState().setModel(getPreferredModel());
}

// Wire Capacitor app lifecycle → force WS reconnect on resume, send suspend on background
registerCapacitorLifecycle(
  () => {
    clientStore.getState().forceReconnect();
    eventBus.ensureConnected();
  },
  () => clientStore.getState().sendSuspend(),
);

// Configure native keyboard behavior (no-op in browser)
configureKeyboard();

// Register for push notifications (no-op in browser)
initPushNotifications();

// Expose on window for console debugging during testing
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__mitzoStore = clientStore;
}
