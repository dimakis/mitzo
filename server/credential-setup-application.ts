import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import type { CredentialConnections } from './credential-connections.js';
import type { ConnectionSetup } from './credential-setup.js';
import { createConnectionSetupContinuation } from './credential-setup-continuation.js';

/** One retry loop for the active credential runtime, with durable work in SQLite. */
export function bindConnectionSetupApplication(
  service: CredentialConnections,
  options: {
    registry: SessionRegistry;
    send(clientId: string, prompt: string, messageId: string): Promise<boolean>;
    isBusy?(session: ManagedSession): boolean;
  },
) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const continuation = createConnectionSetupContinuation({
    ...options,
    send: (clientId, prompt, messageId) =>
      disposed ? Promise.resolve(false) : options.send(clientId, prompt, messageId),
    currentConnection: (id) => {
      if (disposed) throw new Error('Credential runtime retired');
      return service.connection(id);
    },
    pendingReady: () =>
      disposed ? [] : service.setups.pendingReady().filter((setup) => setup.expiresAt > Date.now()),
    markDelivered: (id) => {
      if (!disposed) service.setups.markDelivered(id);
    },
  });
  function schedule(delay = 1500) {
    if (disposed || timer) return;
    const active = service.setups.pendingReady().filter((setup) => setup.expiresAt > Date.now());
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
    canComplete(setup: ConnectionSetup) {
      const owner = options.registry.findBySessionId(setup.sessionId);
      return (
        !disposed &&
        !!owner?.session.inputQueue &&
        !owner.session.abortController.signal.aborted &&
        !options.registry.isClosingOut(owner.clientId) &&
        !options.registry.isUserClose(owner.clientId)
      );
    },
    async onReady(setup: ConnectionSetup) {
      if (disposed || setup.expiresAt <= Date.now()) return false;
      const delivered = await continuation.notify(setup);
      schedule();
      return delivered;
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
