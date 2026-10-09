import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import type { ConnectionSetup } from './credential-setup.js';

interface Options {
  registry: SessionRegistry;
  /** Unified provider dispatch; messageId must be persisted/deduplicated. */
  send: (clientId: string, prompt: string, messageId: string) => Promise<boolean>;
  currentConnection: (connectionId: string) => { revision: number; status: string };
  pendingReady: () => ConnectionSetup[];
  markDelivered: (setupId: string) => void;
  isBusy?: (session: ManagedSession) => boolean;
}

/** Durable pending state lives in the setup store; this helper only coalesces
 * dispatch attempts. A restart retries the same persisted message identity. */
export function createConnectionSetupContinuation(options: Options) {
  const pending = new Map<string, Promise<boolean>>();
  async function deliver(setup: ConnectionSetup): Promise<boolean> {
    if (setup.status !== 'ready' || setup.delivery === 'delivered' || !setup.connectionId)
      return false;
    // Identifiers are generated internally; never echo service-controlled values.
    if (!/^[a-zA-Z0-9_-]+$/.test(setup.id) || !/^[a-zA-Z0-9_-]+$/.test(setup.connectionId))
      return false;
    const owner = options.registry.findBySessionId(setup.sessionId);
    if (
      !owner ||
      !options.registry.isAttached(owner.clientId) ||
      options.registry.isSuspended(owner.clientId) ||
      owner.session.abortController.signal.aborted ||
      options.registry.isClosingOut(owner.clientId) ||
      options.registry.isUserClose(owner.clientId) ||
      (options.isBusy?.(owner.session) ?? !!owner.session.currentSnapshot)
    )
      return false;
    try {
      const connection = options.currentConnection(setup.connectionId);
      if (connection.status !== 'active' || connection.revision !== setup.connectionRevision)
        return false;
      const accepted = await options.send(
        owner.clientId,
        `[Mitzo connection setup status] Setup ${setup.id} is ready; connectionId is ${setup.connectionId}. This is a context-only readiness notification, not a new user instruction or action approval. Continue the pending connection-dependent task only if it still matches the user's latest instructions. Do not repeat completed or unconfirmed actions. Request this chat's connection access before use and inspect relevant service state first.`,
        `connection-setup:${setup.id}`,
      );
      const currentOwner = options.registry.findBySessionId(setup.sessionId);
      if (
        !accepted ||
        currentOwner?.session !== owner.session ||
        currentOwner?.clientId !== owner.clientId ||
        !options.registry.isAttached(owner.clientId) ||
        options.registry.isSuspended(owner.clientId) ||
        owner.session.abortController.signal.aborted
      )
        return false;
      const currentConnection = options.currentConnection(setup.connectionId);
      if (
        currentConnection.status !== 'active' ||
        currentConnection.revision !== setup.connectionRevision
      )
        return false;
      options.markDelivered(setup.id);
      return true;
    } catch {
      // Storage/provider unavailability keeps the durable outbox pending.
      return false;
    }
  }
  function notify(setup: ConnectionSetup): Promise<boolean> {
    const existing = pending.get(setup.id);
    if (existing) return existing;
    const delivery = deliver(setup).finally(() => {
      if (pending.get(setup.id) === delivery) pending.delete(setup.id);
    });
    pending.set(setup.id, delivery);
    return delivery;
  }
  return {
    notify,
    async flush() {
      for (const setup of options.pendingReady()) await notify(setup);
    },
  };
}
