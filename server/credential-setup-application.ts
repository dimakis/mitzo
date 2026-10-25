import type { SecretRelay } from './secret-relay.js';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import type { CredentialConnections } from './credential-connections.js';
import type { ConnectionSetup } from './credential-setup.js';
import { createConnectionSetupContinuation } from './credential-setup-continuation.js';

/** One retry loop for the active credential runtime, with durable work in SQLite. */
export function bindConnectionSetupApplication(
  service: CredentialConnections,
  options: {
    registry: SessionRegistry;
    send(
      clientId: string,
      prompt: string,
      messageId: string,
      assertCurrent: () => void,
    ): Promise<boolean>;
    canSend?(clientId: string): boolean;
    isBusy?(session: ManagedSession, notificationId?: string): boolean;
  },
) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const continuation = createConnectionSetupContinuation({
    ...options,
    send: (clientId, prompt, messageId, assertCurrent) =>
      disposed
        ? Promise.resolve(false)
        : options.send(clientId, prompt, messageId, () => {
            if (disposed) throw Error('Credential runtime retired');
            assertCurrent();
          }),
    currentConnection: (id) => {
      if (disposed) throw new Error('Credential runtime retired');
      return service.connection(id);
    },
    currentRelay: (id) => (disposed ? undefined : service.relay?.browserStatus(id)),
    pendingReady: () => (disposed ? [] : pending()),
    markDelivered: (id) => {
      if (!disposed) {
        if (service.relay?.pendingReady().some((r) => r.id === id)) service.relay.markDelivered(id);
        else service.setups.markDelivered(id);
      }
    },
  });
  const pending = () =>
    [...service.setups.pendingReady(), ...(service.relay?.pendingReady() ?? [])].filter(
      (s) => s.expiresAt > Date.now(),
    );
  const canComplete = (setup: ConnectionSetup | SecretRelay) => {
    const owner = options.registry.findBySessionId(setup.sessionId);
    return (
      !disposed &&
      setup.expiresAt > Date.now() &&
      !!owner?.session.inputQueue &&
      options.canSend?.(owner.clientId) !== false &&
      !owner.session.abortController.signal.aborted &&
      !options.registry.isClosingOut(owner.clientId) &&
      !options.registry.isUserClose(owner.clientId)
    );
  };
  async function onReady(setup: ConnectionSetup | SecretRelay) {
    if (disposed || setup.expiresAt <= Date.now()) return false;
    const delivered = await continuation.notify(setup);
    schedule();
    return delivered;
  }
  function schedule(delay = 1500) {
    if (disposed || timer) return;
    const active = pending();
    if (!active.length) return;
    const remaining = Math.min(...active.map((setup) => setup.expiresAt - Date.now()));
    timer = setTimeout(
      () => {
        timer = undefined;
        void continuation
          .flush()
          .catch(() => undefined)
          .finally(() => schedule());
      },
      Math.min(delay, remaining),
    );
    timer.unref();
  }
  schedule(0);
  return {
    canComplete,
    canCompleteRelay: canComplete,
    onReady,
    onRelayReady: onReady,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
