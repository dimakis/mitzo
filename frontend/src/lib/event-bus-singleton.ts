/**
 * Global EventBus singleton for SSE events.
 *
 * Lazily connected on first import. Hooks subscribe via eventBus.on().
 * On native app resume, the stream is force-recreated: iOS can leave a
 * suspended socket reporting OPEN, and otherwise recovery waits on WebKit's
 * native EventSource retry delay. On page visibility change, a stream that is
 * not OPEN is recreated immediately instead of waiting for that retry.
 */

import { EventBus } from '@mitzo/client';
import { getEventSourceUrl, markAuthLost, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from './api-fetch';

export const eventBus = new EventBus();
let authBlocked = true;

export function ensureEventBusConnected(options: { force?: boolean } = {}): void {
  if (!authBlocked) eventBus.ensureConnected(options);
}

eventBus.on('auth_expired', () => {
  eventBus.disconnect();
  markAuthLost();
});

// Recover from dead SSE connections when page becomes visible again
// (e.g., iOS Safari backgrounding kills EventSource without firing error)
if (typeof document !== 'undefined') {
  window.addEventListener(AUTH_LOST_EVENT, () => {
    authBlocked = true;
    eventBus.disconnect();
  });
  window.addEventListener(AUTH_RESTORED_EVENT, () => {
    authBlocked = false;
    eventBus.disconnect();
    eventBus.connect(() => getEventSourceUrl('/api/events'));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !authBlocked) {
      ensureEventBusConnected();
    }
  });
}
