import type { SessionActivity } from '@mitzo/protocol';
import { eventBus } from './event-bus-singleton';

// The application bootstrap imports this store before opening its global SSE connection.
// Retain its current snapshot independently of mounted consumers: opening a chat
// during a long command must not wait for another activity event to learn its clock.
let snapshot = {
  activities: [] as SessionActivity[],
  lastKnownActivities: [] as SessionActivity[],
  connected: eventBus.connected,
};
const listeners = new Set<() => void>();
let authLost = false;
function publish(next: typeof snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
eventBus.on('session_activity', (data) => {
  if (authLost) return;
  const activities = data as SessionActivity[];
  publish({ ...snapshot, activities, lastKnownActivities: activities });
});
eventBus.onConnectionChange((connected) => {
  connected = connected && !authLost;
  publish({ ...snapshot, connected, activities: connected ? snapshot.activities : [] });
});
if (typeof window !== 'undefined') {
  const clear = () => publish({ activities: [], lastKnownActivities: [], connected: false });
  window.addEventListener('mitzo:auth-lost', () => {
    authLost = true;
    clear();
  });
  window.addEventListener('mitzo:auth-restored', () => {
    authLost = false;
    clear();
  });
}
export const subscribeSessionActivity = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getSessionActivitySnapshot = () => snapshot;
