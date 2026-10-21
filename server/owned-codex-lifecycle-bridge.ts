import type { CodexLifecycleTransport } from './codex-app-server-client.js';
import type { FrozenHostCodexBootstrapLease } from './frozen-host-codex-bootstrap.js';

const unavailable = () => new Error('Owned Codex lifecycle unavailable');

/** Installs native lifecycle restrictions before bootstrap, then hands that exact
 * client to one conversation owner. The lease getter is server composition,
 * never request data. Closing preserves provider/workspace custody; this bridge
 * neither retries effects nor creates or rebinds a replacement transport.
 */
export class OwnedCodexLifecycleBridge {
  readonly lifecycle: CodexLifecycleTransport;
  #owner?: CodexLifecycleTransport;
  #lease?: FrozenHostCodexBootstrapLease;
  #attachmentAttempted = false;
  #closed = false;
  #leaseClosed = false;
  #abort = new AbortController();

  constructor(private readonly currentLease: () => FrozenHostCodexBootstrapLease | undefined) {
    this.lifecycle = Object.freeze({
      onNotification: (method, params) => {
        try {
          if (this.#closed) throw unavailable();
          if (!this.#owner) {
            // These bootstrap observations have no conversation execution or
            // host-tool effects. They confer no login or execution authority;
            // the bootstrap lease independently verifies account and file custody.
            if (method === 'account/updated' || method === 'account/rateLimits/updated') return;
            if (
              method === 'remoteControl/status/changed' &&
              params.status === 'disabled' &&
              params.environmentId === null
            )
              return;
            if (
              method === 'account/login/completed' &&
              params.loginId === null &&
              params.success === true &&
              params.error === null
            )
              return;
            // Every other unsolicited notification refuses, including remote
            // execution, another login flow and pre-attachment thread/turn events.
            throw unavailable();
          }
          this.assertCurrentSync();
          this.#owner.onNotification(method, params);
        } catch {
          this.close();
          throw unavailable();
        }
      },
      onRequest: async (method, params, signal) => {
        try {
          if (!this.#owner) throw unavailable();
          signal.throwIfAborted();
          const lease = this.assertCurrentSync();
          await lease.assertCurrent();
          signal.throwIfAborted();
          this.assertCurrentSync();
          const result = await this.#owner.onRequest(
            method,
            params,
            AbortSignal.any([signal, this.#abort.signal]),
          );
          // The existing conversation/tool ledger owns any effects already
          // completed by the callback. Failure here never asserts no execution.
          signal.throwIfAborted();
          this.assertCurrentSync();
          return result;
        } catch {
          this.close();
          throw unavailable();
        }
      },
      onClose: () => this.close(),
    } satisfies CodexLifecycleTransport);
  }

  private assertCurrentSync(): FrozenHostCodexBootstrapLease {
    const lease = this.currentLease();
    if (this.#closed || !this.#lease || lease !== this.#lease) throw unavailable();
    lease.assertCurrentSync();
    if (this.#closed || this.currentLease() !== lease) throw unavailable();
    return lease;
  }

  private close(): void {
    const firstClose = !this.#closed;
    this.#closed = true;
    this.#abort.abort(unavailable());
    // Transport closure may precede publication of the bootstrap lease. Keep
    // the closed state and also close a lease discovered by a delayed attach.
    if (!this.#lease) {
      try {
        this.#lease = this.currentLease();
      } catch {
        /* Missing authority cannot revive a closed bridge. */
      }
    }
    if (this.#lease && !this.#leaseClosed) {
      this.#leaseClosed = true;
      try {
        this.#lease.close();
      } catch {
        /* Preserve custody even when transport shutdown fails. */
      }
    }
    if (firstClose && this.#owner) {
      try {
        this.#owner.onClose(unavailable());
      } catch {
        /* An observer cannot revive this transport or expose provider text. */
      }
    }
  }

  /** Consumed by the conversation's synchronous createClient callback after
   * bootstrap has independently qualified this lease. No native launch occurs.
   */
  attach(callbacks: CodexLifecycleTransport): FrozenHostCodexBootstrapLease['client'] {
    if (this.#closed) {
      this.close();
      throw unavailable();
    }
    if (this.#attachmentAttempted) throw unavailable();
    this.#attachmentAttempted = true;
    try {
      const lease = this.currentLease();
      if (!lease) throw unavailable();
      this.#lease = lease;
      this.assertCurrentSync();
      const owner: CodexLifecycleTransport = {
        onNotification: callbacks.onNotification.bind(callbacks),
        onRequest: callbacks.onRequest.bind(callbacks),
        onClose: callbacks.onClose.bind(callbacks),
      };
      if (this.#closed || this.currentLease() !== lease) throw unavailable();
      this.#owner = owner;
      return lease.client;
    } catch {
      this.close();
      throw unavailable();
    }
  }
}
