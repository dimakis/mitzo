/**
 * Reuse window for a successful deep authority proof, measured from the start of
 * the proof, so the observed state is never older than this window.
 *
 * Every Claude SDK hook, permission decision, MCP handler and query-loop step
 * asks for current authority. That is roughly ten or more requests per tool
 * call. Re-running the deep proof for each one meant workspace revalidation,
 * Git inspection, repository-ledger reads and a credential status process.
 * Under several concurrent chats this saturated the server's event loop (see
 * Telos slice facabd5d29f01bc9). The cheap synchronous fences still run on every
 * call. Only the deep re-proof is shared within this window.
 */
export const SDK_AUTHORITY_PROOF_TTL_MS = 5_000;

interface ProofEntry {
  readonly key: string;
  readonly startedAt: number;
  readonly promise: Promise<void>;
  settled: boolean;
}

/**
 * Shares one expensive asynchronous authority proof between concurrent callers,
 * and reuses a successful proof for a short window.
 *
 * - The same key with a proof still in flight joins that proof (single-flight).
 * - The same key with a successful proof younger than the TTL reuses it.
 * - A different key, an expired proof or a failed proof starts a new proof.
 *
 * Failures are never cached. Every concurrent waiter receives the original
 * failure, and the next caller proves again. Callers remain responsible for the
 * synchronous fences (operator, ownership, receipts, credential identity) on
 * every call. This class only removes repeated deep re-proofs.
 */
export class AuthorityProofCache {
  #entry: ProofEntry | undefined;

  constructor(
    private readonly ttlMs: number = SDK_AUTHORITY_PROOF_TTL_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  run(key: string, prove: () => Promise<void>): Promise<void> {
    const current = this.#entry;
    if (current?.key === key && (!current.settled || this.now() - current.startedAt < this.ttlMs))
      return current.promise;
    const startedAt = this.now();
    let promise: Promise<void>;
    try {
      promise = prove();
    } catch (error) {
      return Promise.reject(error);
    }
    const entry: ProofEntry = { key, startedAt, promise, settled: false };
    this.#entry = entry;
    promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        // Never retain a failed proof; the next caller must prove again.
        if (this.#entry === entry) this.#entry = undefined;
      },
    );
    return promise;
  }

  /** Forget any retained proof, for example after an observed revocation. */
  invalidate() {
    this.#entry = undefined;
  }
}
