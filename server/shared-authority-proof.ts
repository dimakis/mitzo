/**
 * Shares one in-flight deep authority proof between concurrent callers.
 *
 * Claude SDK hooks, permission decisions, MCP handlers and query-loop steps ask
 * for current authority roughly ten or more times per tool call, and many of
 * those requests overlap. Each one ran its own deep proof: workspace
 * revalidation (Git inspection, repository-ledger reads) and the repository
 * credential check (`claude auth status` or a keychain read). With several
 * concurrent chats this saturated the server event loop (Telos slice
 * facabd5d29f01bc9).
 *
 * Callers that arrive while a proof for the same key is still running join that
 * proof. A settled proof is never reused. The first caller after settlement
 * proves again, so mutable conditions (Git HEAD/config, repository connection
 * grants, keychain credential version) are observed afresh at every boundary
 * that starts after the previous proof finished. A failure reaches every
 * waiter, and the next caller proves again.
 *
 * Each waiter may abandon its own wait through its signal, without cancelling
 * the shared proof or any other waiter. The proof itself runs under the
 * owner's lifetime, which the caller supplies through `prove`.
 *
 * At most one deep proof per key runs at a time, so the expensive work is
 * bounded by the number of active owners, not by hook fan-out.
 */
export class SharedAuthorityProof {
  readonly #inFlight = new Map<string, Promise<void>>();

  run(key: string, prove: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let shared = this.#inFlight.get(key);
    if (!shared) {
      let started: Promise<void>;
      try {
        started = prove();
      } catch (error) {
        return Promise.reject(error);
      }
      shared = started;
      this.#inFlight.set(key, started);
      const settle = () => {
        if (this.#inFlight.get(key) === started) this.#inFlight.delete(key);
      };
      // Handles both outcomes, so an abandoned shared failure is never unhandled.
      started.then(settle, settle);
    }
    return signal ? abandonable(shared, signal) : shared;
  }

  /** Number of proofs currently running; for diagnostics and tests. */
  get inFlight(): number {
    return this.#inFlight.size;
  }
}

function abandonable(shared: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abandon = () => reject(signal.reason);
    signal.addEventListener('abort', abandon, { once: true });
    shared.then(
      () => {
        signal.removeEventListener('abort', abandon);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abandon);
        reject(error);
      },
    );
  });
}
