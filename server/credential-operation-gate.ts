import { AsyncLocalStorage } from 'node:async_hooks';

/** Only read-only credential qualification can join the caller's live mutation
 * reservation. Unrelated callers still queue, and escaped async contexts cannot
 * retain authority after the owning operation ends. */
export class CredentialOperationGate {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly owner = new AsyncLocalStorage<{ active: boolean }>();

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.owner.getStore()?.active)
      return Promise.reject(Error('Connection mutation cannot reenter its owning gate'));
    const result = this.tail.then(async () => {
      signal?.throwIfAborted();
      const owner = { active: true };
      return this.owner.run(owner, async () => {
        try {
          return await work();
        } finally {
          owner.active = false;
        }
      });
    });
    // A cancelled waiter must never release an earlier operation's reservation.
    this.tail = result.catch(() => {});
    return this.cancelWait(result, signal);
  }

  async read<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const owner = this.owner.getStore();
    if (!owner?.active) return this.run(work, signal);
    const result = await work();
    signal?.throwIfAborted();
    if (!owner.active) throw Error('Credential read reservation expired');
    return result;
  }

  private cancelWait<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      const done = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      result.then(
        (value) => {
          done();
          resolve(value);
        },
        (error) => {
          done();
          reject(error);
        },
      );
    });
  }
}
