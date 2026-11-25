import type { EventStore } from './event-store.js';
import type { SessionRegistry } from './session-registry.js';
import { ContextSnapshotLifecycle } from './context-snapshot-lifecycle.js';

/** Resolves only the existing attached session; no fallback to another account/runtime.
 * Adapters install a port only after qualifying the actual native query owner.
 */
export function createRuntimeContextSnapshots(events: EventStore, registry: SessionRegistry) {
  return new ContextSnapshotLifecycle({
    events,
    generation: (id) => registry.findBySessionId(id)?.session.contextSnapshotAttachment,
    current(id) {
      const found = registry.findBySessionId(id);
      if (!found) return;
      const { session, clientId } = found;
      if (
        session.abortController.signal.aborted ||
        !session.transport.isOpen() ||
        !registry.isAttached(clientId) ||
        registry.isSuspended(clientId)
      )
        return;
      return session.contextSnapshotOwner;
    },
  });
}
