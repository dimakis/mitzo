/**
 * Global EventBus singleton for SSE events.
 *
 * Lazily connected on first import. Hooks subscribe via eventBus.on().
 * On iOS resume, ensureConnected() is called to recover from CLOSED state.
 */

import { EventBus } from '@mitzo/client';
import { getApiBaseUrl } from './api-fetch';

export const eventBus = new EventBus();

// Connect immediately — EventSource auto-reconnects natively
const sseUrl = `${getApiBaseUrl()}/api/events`;
eventBus.connect(sseUrl);
