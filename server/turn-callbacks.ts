import { SessionRuntimeError } from './session-runtime-error.js';
import { AsyncLocalStorage } from 'node:async_hooks';
export type TurnCallbackRunner = <T>(operation: () => Promise<T>) => Promise<T>;
const effectOwners = new AsyncLocalStorage<() => void>();
/** A fresh effect check in an original callback cannot borrow a later turn. */
export function assertTurnCallbackEffects(): void {
  effectOwners.getStore()?.();
}
const outcomes = new WeakMap<object, 'settled' | 'unknown'>();
/** Original trusted callback results only: JSON, spreads and database copies cannot carry this receipt. */
export function retainCallbackOutcome<T extends object>(
  result: T,
  outcome: 'settled' | 'unknown',
): T {
  outcomes.set(result, outcome);
  return result;
}
export function callbackOutcome(result: unknown): 'settled' | 'unknown' {
  if (result && typeof result === 'object') {
    const retained = outcomes.get(result);
    if (retained) return retained;
    if (
      ('isError' in result && result.isError === true) ||
      ('is_error' in result && result.is_error === true)
    )
      return 'unknown';
  }
  return 'settled';
}
export function retainedCallbackOutcome(result: object) {
  return outcomes.get(result);
}
export function copyCallbackOutcome<T extends object>(source: object, target: T): T {
  const retained = outcomes.get(source);
  return retained ? retainCallbackOutcome(target, retained) : target;
}

/** Original in-memory callbacks only. A reconstructed owner cannot manufacture
 * settlement, replay a tool, or treat a missing durable result as success. */
export class TurnCallbacks {
  private pending = new Set<Promise<unknown>>();
  private sealed = false;
  private failure?: { cause: unknown };
  get size() {
    return this.pending.size;
  }
  get needsSettlement() {
    return this.pending.size > 0 || !!this.failure;
  }
  track<T>(
    operation: () => Promise<T>,
    knownCancellation?: (error: unknown) => boolean,
  ): Promise<T> {
    if (this.sealed) return Promise.reject(new SessionRuntimeError('turn_completed'));
    // Register before invoking application code, including synchronous terminal notifications.
    let resolve!: (result: T | PromiseLike<T>) => void;
    let reject!: (cause: unknown) => void;
    const work = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const observation = work.then(
      (result) => {
        this.pending.delete(observation);
        if (this.sealed && callbackOutcome(result) === 'unknown')
          this.failure ??= { cause: new SessionRuntimeError('callbacks_failed') };
      },
      (cause: unknown) => {
        this.pending.delete(observation);
        if (!knownCancellation?.(cause)) this.failure ??= { cause };
      },
    );
    this.pending.add(observation);
    try {
      resolve(
        effectOwners.run(() => {
          if (this.sealed) throw new SessionRuntimeError('turn_completed');
        }, operation),
      );
    } catch (cause) {
      reject(cause);
    }
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
        Promise.all([...this.pending]),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => reject(new SessionRuntimeError('callbacks_pending')), timeoutMs);
          timer.unref?.();
          if (signal.aborted) onAbort();
        }),
      ]);
      signal.throwIfAborted();
      if (this.failure)
        throw new SessionRuntimeError('callbacks_failed', { cause: this.failure.cause });
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
