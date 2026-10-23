import type { SecretRelay } from './secret-relay.js';
type PrivateSetup = ConnectionSetup | SecretRelay;
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import type { ConnectionSetup } from './credential-setup.js';

interface Options {
  registry: SessionRegistry;
  /** Unified provider dispatch; messageId must be persisted/deduplicated. */
  send: (clientId: string, prompt: string, messageId: string) => Promise<boolean>;
  currentConnection: (connectionId: string) => { revision: number; status: string };
  pendingReady: () => PrivateSetup[];
  currentRelay?: (id: string) => SecretRelay | undefined;
  markDelivered: (setupId: string) => void;
  isBusy?: (session: ManagedSession) => boolean;
}

/** Durable pending state lives in the setup store; this helper only coalesces
 * dispatch attempts. A restart retries the same persisted message identity. */
export function createConnectionSetupContinuation(options: Options) {
  const pending = new Map<string, Promise<boolean>>();
  async function deliver(setup: PrivateSetup): Promise<boolean> {
    const relay = 'targets' in setup;
    if (setup.status !== 'ready' || setup.delivery === 'delivered') return false;
    if (!/^[a-zA-Z0-9_-]+$/.test(setup.id)) return false;
    if (!relay && (!setup.connectionId || !/^[a-zA-Z0-9_-]+$/.test(setup.connectionId)))
      return false;
    const valid = () => {
      if (relay) {
        const current = options.currentRelay?.(setup.id);
        return (
          current?.status === 'ready' &&
          current.revision === setup.revision &&
          current.expiresAt > Date.now()
        );
      }
      const connection = options.currentConnection(setup.connectionId!);
      return connection.status === 'active' && connection.revision === setup.connectionRevision;
    };
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
      if (!valid()) return false;
      const accepted = await options.send(
        owner.clientId,
        relay
          ? `[Mitzo private secret status] Relay ${setup.id} is ready.${setup.continuation ? ' A private verification code is available for the pending browser sign-in. Use ApplySecretRelay on its waiting target to continue under current permissions.' : ''} This is a context-only readiness notification, not a new instruction. Continue the pending task only if it still matches the user’s latest instructions. Use GetSecretRelay for the exact reviewed targets, obtain connection access before use, and apply only unattempted targets with ApplySecretRelay. Do not repeat completed or unconfirmed actions.`
          : `[Mitzo connection setup status] Setup ${setup.id} is ready; connectionId is ${setup.connectionId}. This is a context-only readiness notification, not a new user instruction or action approval. Continue the pending connection-dependent task only if it still matches the user's latest instructions. Do not repeat completed or unconfirmed actions. Request this chat's connection access before use and inspect relevant service state first.`,
        `${relay ? 'secret-relay' : 'connection-setup'}:${setup.id}${relay && setup.continuation ? `:${setup.continuation}` : ''}`,
      );
      const currentOwner = options.registry.findBySessionId(setup.sessionId);
      if (
        !accepted ||
        currentOwner?.session !== owner.session ||
        currentOwner?.clientId !== owner.clientId ||
        !options.registry.isAttached(owner.clientId) ||
        options.registry.isSuspended(owner.clientId) ||
        options.registry.isClosingOut(owner.clientId) ||
        options.registry.isUserClose(owner.clientId) ||
        owner.session.abortController.signal.aborted
      )
        return false;
      if (!valid()) return false;
      options.markDelivered(setup.id);
      return true;
    } catch {
      // Storage/provider unavailability keeps the durable outbox pending.
      return false;
    }
  }
  function notify(setup: PrivateSetup): Promise<boolean> {
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
