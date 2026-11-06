import {
  CodexServerRequestResolvedError,
  CodexTurnCompletedError,
  CodexTransportError,
  CodexHostToolRequestError,
  type CodexLifecycleTransport,
} from './codex-app-server-client.js';
import type { FrozenHostCodexBootstrapLease } from './frozen-host-codex-bootstrap.js';
import { observeLocalCodexPhase } from './local-codex-observation.js';
import { findSessionRuntimeError } from './session-runtime-error.js';

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
  #notificationTail?: Promise<void>;
  #pendingNotificationBytes = 0;
  #pendingNotifications = 0;

  constructor(
    private readonly currentLease: () => FrozenHostCodexBootstrapLease | undefined,
    private readonly options: {
      admissionTimeoutMs?: number;
      maxPendingNotificationBytes?: number;
    } = {},
  ) {
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
          const lease = this.#lease;
          if (!lease) throw unavailable();
          const prior = this.#notificationTail;
          const qualification = prior
            ? undefined
            : this.qualifyCredentialRefresh(lease, this.#abort.signal);
          // Every started asynchronous operation gets a rejection observer in
          // this turn, including quota/serialization failure before enqueue.
          if (qualification) void qualification.catch(() => {});
          const deliver = () => {
            this.assertCurrentSync();
            this.#owner!.onNotification(method, params);
          };
          if (qualification || prior) {
            const bytes = Buffer.byteLength(method) + Buffer.byteLength(JSON.stringify(params));
            if (
              this.#pendingNotificationBytes + bytes >
                (this.options.maxPendingNotificationBytes ?? 8 * 1024 * 1024) ||
              this.#pendingNotifications >= 4096
            )
              throw unavailable();
            this.#pendingNotificationBytes += bytes;
            this.#pendingNotifications++;
            const pending = (prior ?? Promise.resolve())
              .then(() =>
                prior ? this.qualifyCredentialRefresh(lease, this.#abort.signal) : qualification,
              )
              .then(deliver);
            this.#notificationTail = pending;
            const settled = () => {
              this.#pendingNotificationBytes -= bytes;
              this.#pendingNotifications--;
              if (this.#notificationTail === pending) this.#notificationTail = undefined;
            };
            void pending.then(settled, (error) => {
              settled();
              this.close(
                findSessionRuntimeError(error) ??
                  new CodexTransportError('connection', { reason: 'notification_handler_failed' }),
              );
            });
          } else deliver();
        } catch (error) {
          this.close(
            findSessionRuntimeError(error) ??
              (error instanceof CodexTransportError
                ? error
                : new CodexTransportError('connection', { reason: 'notification_handler_failed' })),
          );
          throw findSessionRuntimeError(error) ?? unavailable();
        }
      },
      onRequest: async (method, params, signal, context) => {
        let originalLease: FrozenHostCodexBootstrapLease | undefined;
        let preExecutionRefusal: CodexHostToolRequestError | undefined;
        const requestId = context?.requestId;
        try {
          if (!this.#owner) throw unavailable();
          signal.throwIfAborted();
          const captured = this.#lease;
          if (!captured) throw unavailable();
          originalLease = captured;
          if (this.#notificationTail) await this.#notificationTail;
          const qualification = this.qualifyCredentialRefresh(captured, signal);
          if (qualification) await qualification;
          const lease = this.assertCurrentSync();
          originalLease = lease;
          context?.registerResponseFence?.(() => {
            signal.throwIfAborted();
            this.assertCurrentSync();
          });
          await observeLocalCodexPhase('host_tool_admission', () => this.admit(lease, signal));
          signal.throwIfAborted();
          this.assertCurrentSync();
          const requestContext =
            context && method === 'item/tool/call'
              ? Object.freeze({
                  ...context,
                  registerPreExecutionRefusal: (error: CodexHostToolRequestError) => {
                    if (
                      method === 'item/tool/call' &&
                      error instanceof CodexHostToolRequestError &&
                      ['invalid_tool_request', 'tool_unavailable'].includes(error.category)
                    )
                      preExecutionRefusal = error;
                  },
                })
              : context;
          const result = await observeLocalCodexPhase('host_tool_execution', () =>
            this.#owner!.onRequest(
              method,
              params,
              AbortSignal.any([signal, this.#abort.signal]),
              ...(requestContext ? [requestContext] : []),
            ),
          );
          // The existing conversation/tool ledger owns any effects already
          // completed by the callback. Failure here never asserts no execution.
          const qualificationAfter = this.qualifyCredentialRefresh(lease, signal);
          if (qualificationAfter) await qualificationAfter;
          signal.throwIfAborted();
          this.assertCurrentSync();
          return result;
        } catch (error) {
          let safelyRefused = false;
          if (preExecutionRefusal !== undefined && error === preExecutionRefusal) {
            try {
              signal.throwIfAborted();
              safelyRefused = this.assertCurrentSync() === originalLease;
            } catch {
              /* Changed authority still retires the original transport. */
            }
          }
          let requestAlreadyResolved = false;
          if (
            signal.aborted &&
            (signal.reason instanceof CodexServerRequestResolvedError ||
              (signal.reason instanceof CodexTurnCompletedError &&
                signal.reason.threadId === params.threadId &&
                signal.reason.turnId === params.turnId)) &&
            signal.reason.requestId === requestId &&
            originalLease &&
            !this.#abort.signal.aborted
          ) {
            try {
              requestAlreadyResolved = this.assertCurrentSync() === originalLease;
            } catch {
              /* A revoked/replaced owner still closes the lease. */
            }
          }
          const reviewed = findSessionRuntimeError(error);
          if (!requestAlreadyResolved && !safelyRefused) this.close(reviewed);
          throw safelyRefused ? error : (reviewed ?? unavailable());
        }
      },
      onClose: (error) =>
        this.close(
          findSessionRuntimeError(error) ??
            (error instanceof CodexTransportError ? error : unavailable()),
        ),
    } satisfies CodexLifecycleTransport);
  }

  /** Public issuer-key reads may await; no native event or result is delivered
   * until the unchanged synchronous account/operator/response fences pass. */
  private qualifyCredentialRefresh(
    lease: FrozenHostCodexBootstrapLease,
    signal: AbortSignal,
  ): void | Promise<void> {
    signal.throwIfAborted();
    if (
      this.#closed ||
      this.#abort.signal.aborted ||
      this.#lease !== lease ||
      this.currentLease() !== lease
    )
      throw unavailable();
    return lease.qualifyCredentialRefresh?.(signal);
  }

  private async admit(lease: FrozenHostCodexBootstrapLease, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const current = AbortSignal.any([signal, this.#abort.signal, controller.signal]);
    const timer = setTimeout(() => {
      const error = new CodexTransportError('timeout', {
        reason: 'host_tool_admission_timeout',
      });
      // Retain the cause before cancellation makes the physical reader retire
      // its lease and synchronously reenter with a generic transport closure.
      this.close(error);
      controller.abort(error);
    }, this.options.admissionTimeoutMs ?? 15_000);
    let abort: () => void = () => {};
    try {
      await Promise.race([
        Promise.resolve().then(() => {
          current.throwIfAborted();
          return lease.assertToolCurrent ? lease.assertToolCurrent(current) : lease.assertCurrent();
        }),
        new Promise<never>((_, reject) => {
          abort = () => reject(current.reason);
          current.addEventListener('abort', abort, { once: true });
          if (current.aborted) abort();
        }),
      ]);
      current.throwIfAborted();
    } finally {
      clearTimeout(timer);
      current.removeEventListener('abort', abort);
    }
  }

  private assertCurrentSync(): FrozenHostCodexBootstrapLease {
    const lease = this.currentLease();
    if (this.#closed || !this.#lease || lease !== this.#lease) throw unavailable();
    lease.assertCurrentSync();
    if (this.#closed || this.currentLease() !== lease) throw unavailable();
    return lease;
  }

  private close(reason: Error = unavailable()): void {
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
    // Record the bounded cause before lease.close synchronously reenters the
    // native onClose callback with its generic connection error.
    if (firstClose && this.#owner) {
      try {
        this.#owner.onClose(reason);
      } catch {
        /* An observer cannot revive this transport or expose provider text. */
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
