import { SessionRuntimeError } from './session-runtime-error.js';
export type TurnCallbackRunner = <T>(operation: () => Promise<T>) => Promise<T>;

/** Original in-memory callbacks only. A reconstructed owner cannot manufacture
 * settlement, replay a tool, or treat a missing durable result as success. */
export class TurnCallbacks {
  private pending = new Set<Promise<unknown>>();
  private sealed = false;
  get size() {
    return this.pending.size;
  }
  track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new SessionRuntimeError('turn_completed'));
    // Register before invoking application code, including synchronous terminal notifications.
    const work = Promise.resolve().then(operation);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }
  seal() {
    this.sealed = true;
  }
  async settle(signal: AbortSignal, timeoutMs = 15_000): Promise<void> {
    this.seal();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    try {
      signal.throwIfAborted();
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => reject(new SessionRuntimeError('callbacks_pending')), timeoutMs);
          timer.unref?.();
          if (signal.aborted) onAbort();
        }),
      ]);
      signal.throwIfAborted();
      // Let the original transport finish its response fences/write. They can
      // still revoke this owner; settling a callback cannot revive it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
