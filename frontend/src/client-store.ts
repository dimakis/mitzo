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
import {
  apiFetch,
  getApiBaseUrl,
  getEventSourceUrl,
  getWsChatUrl,
  isLogoutPending,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
} from './lib/api-fetch';
import { isCapacitor, registerCapacitorLifecycle } from './lib/capacitor';
import { parseChatTransportPreference, shouldUseSseTransport } from './lib/chat-transport';
import { configureKeyboard } from './lib/keyboard';
import { initPushNotifications } from './lib/push';
import { eventBus } from './lib/event-bus-singleton';
import { getPreferredModel } from './lib/model-preference';

/**
 * Transport selector — SSE + HTTP POST is the default transport (Transport SSOT P0).
 * This is an intentional flip from WS-default per the transport-ssot design doc.
 * Set localStorage 'mitzo:transport' to 'ws' to fall back to WebSocket.
 *
 * Browser defaults to SSE; native WKWebView defaults to the hardened WS path.
 * Override: localStorage.setItem('mitzo:transport', 'sse' | 'ws'); location.reload();
 */
const preference =
  typeof window !== 'undefined'
    ? parseChatTransportPreference(localStorage.getItem('mitzo:transport'))
    : null;
const useSSE = typeof window !== 'undefined' && shouldUseSseTransport(isCapacitor(), preference);

const sseConfig: SseConnectionConfig | undefined = useSSE
  ? {
      baseUrl: getApiBaseUrl(),
      outboxStorage: sessionStorage,
      fetch: (url, init) => apiFetch(url, init),
      buildEventUrl: () => getEventSourceUrl('/api/chat/events'),
      suspendUrl: `${getApiBaseUrl()}/api/sessions/suspend`,
    }
  : undefined;

export const clientStore = createMitzoStore({
  transport: {
    fetch: (url, init) => apiFetch(url, init),
  },
  wsConfig: {
    buildUrl: () => getWsChatUrl(),
    checkAuth: () => apiFetch('/api/auth/check'),
    createWebSocket: (url) => new WebSocket(url) as import('@mitzo/client').WebSocketLike,
    reconnectDelayMs: 500,
    suspendUrl: `${getApiBaseUrl()}/api/sessions/suspend`,
  },
  ...(sseConfig ? { sseConfig } : {}),
});

if (isLogoutPending()) clientStore.getState().invalidateAuthentication();

if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_LOST_EVENT, () => clientStore.getState().invalidateAuthentication());
  window.addEventListener(AUTH_RESTORED_EVENT, () => clientStore.getState().forceReconnect());
}

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
