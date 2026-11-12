import { onPermissionAudit } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
/** All transports and provider adapters converge on the shared decision owner. */
export function persistPermissionAudit(events: Pick<EventStore, 'append'>): () => void {
  return onPermissionAudit((event) => {
    if (event.sessionId) events.append(event.sessionId, 'permission_audit', { ...event });
  });
}
