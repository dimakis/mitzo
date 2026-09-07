/**
 * Global EventBus singleton for SSE events.
 *
 * Lazily connected on first import. Hooks subscribe via eventBus.on().
 * On iOS resume, ensureConnected() is called to recover from CLOSED state.
 * On page visibility change, ensureConnected() reconnects if connection died.
 */

import { EventBus } from '@mitzo/client';
import { getEventSourceUrl } from './api-fetch';

export const eventBus = new EventBus();

// Connect immediately — EventSource auto-reconnects natively
eventBus.connect(() => getEventSourceUrl('/api/events'));

// Recover from dead SSE connections when page becomes visible again
// (e.g., iOS Safari backgrounding kills EventSource without firing error)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      eventBus.ensureConnected();
    }
  });
}
