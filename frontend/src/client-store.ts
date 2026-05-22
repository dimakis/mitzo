/**
 * Bootstrap @mitzo/client store for the browser environment.
 *
 * This creates a MitzoStore with browser-native WebSocket and fetch.
 * Currently wired in for integration testing — the existing hooks
 * continue to drive the UI. This will become the primary state layer
 * once the frontend migration is complete.
 */

import { createMitzoStore } from '@mitzo/client';
import { apiFetch, getApiBaseUrl, getWsChatUrl } from './lib/api-fetch';
import { registerCapacitorLifecycle } from './lib/capacitor';
import { configureKeyboard } from './lib/keyboard';
import { initPushNotifications } from './lib/push';
import { eventBus } from './lib/event-bus-singleton';
import { getPreferredModel } from './lib/model-preference';

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
