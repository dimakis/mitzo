import { launchDraftDelivery } from './lib/launch-draft-delivery';
import { briefingCommandHandoff } from './lib/briefing-registration';
import { createReviewedOutboxStorage } from './lib/reviewed-outbox-storage';
/**
 * Bootstrap @mitzo/client store for the browser environment.
 *
 * Chat events use EventSource; commands use acknowledged HTTP POST delivery.
 * WebSocket remains available through an explicit diagnostic override.
 */

import { createMitzoStore } from '@mitzo/client';
import type { SseConnectionConfig } from '@mitzo/client';
import {
  apiFetch,
  getApiBaseUrl,
  getEventSourceUrl,
  getWsChatUrl,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
} from './lib/api-fetch';
import { isCapacitor, registerCapacitorLifecycle } from './lib/capacitor';
import { parseChatTransportPreference, shouldUseSseTransport } from './lib/chat-transport';
import { configureKeyboard } from './lib/keyboard';
import { initPushNotifications } from './lib/push';
import { configureNativeNotificationServer } from './lib/watch-auth';
import { ensureEventBusConnected } from './lib/event-bus-singleton';
import { getPreferredModel } from './lib/model-preference';

/**
 * Transport selector — SSE + HTTP POST is the default transport (Transport SSOT P0).
 * This is an intentional flip from WS-default per the transport-ssot design doc.
 * Set localStorage 'mitzo:transport' to 'ws' to fall back to WebSocket.
 *
 * Browser and native WKWebView both default to SSE.
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
      requireDurableBriefings: true,
      fetch: (url, init) => apiFetch(url, init),
      buildEventUrl: () => getEventSourceUrl('/api/chat/events'),
      suspendUrl: `${getApiBaseUrl()}/api/sessions/suspend`,
    }
  : undefined;

export const clientStore = createMitzoStore({
  launchDrafts: launchDraftDelivery,
  sendHandoff: briefingCommandHandoff,
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
  ...(typeof window !== 'undefined'
    ? {
        localFirstCommandConfig: {
          url: `${getApiBaseUrl()}/api/chat/local-codex/send`,
          storage: createReviewedOutboxStorage(
            localStorage,
            new URL(`${getApiBaseUrl()}/api/chat/local-codex/send`, window.location.href).href,
            'local',
          ),
        },
        reviewedSendConfig: {
          url: `${getApiBaseUrl()}/api/chat/send`,
          storage: createReviewedOutboxStorage(
            localStorage,
            new URL(`${getApiBaseUrl()}/api/chat/send`, window.location.href).href,
          ),
        },
      }
    : {}),
  initiallyAuthenticated: false,
});

if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_LOST_EVENT, () => clientStore.getState().invalidateAuthentication());
  window.addEventListener(AUTH_RESTORED_EVENT, () =>
    clientStore.getState().restoreAuthentication(),
  );
}

// Sync localStorage model preference into the store so sendMessage() includes it
if (typeof window !== 'undefined') {
  clientStore.getState().setModel(getPreferredModel());
}

// Wire Capacitor app lifecycle → recover the event stream on resume, suspend on background
registerCapacitorLifecycle(
  () => {
    clientStore.getState().forceReconnect();
    ensureEventBusConnected();
    void initPushNotifications();
  },
  () => clientStore.getState().sendSuspend(),
);

// Configure native keyboard behavior (no-op in browser)
configureKeyboard();

// Register for push notifications (no-op in browser)
initPushNotifications();
void configureNativeNotificationServer(getApiBaseUrl());

// Expose on window for console debugging during testing
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__mitzoStore = clientStore;
}
