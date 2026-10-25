import { AsyncLocalStorage } from 'node:async_hooks';

type Mode = 'read' | 'write';
/** Runtime allocation and credential observations share read reservations.
 * Rotation/revocation requires exclusive mutation authority. FIFO writers cannot
 * be starved by new reads, and only nested reads may join an active owner. */
export class CredentialOperationGate {
  private readers = 0;
  private writing = false;
  private readonly queue: Array<{ mode: Mode; begin(): void }> = [];
  private readonly owner = new AsyncLocalStorage<{ active: boolean }>();

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.owner.getStore()?.active)
      return Promise.reject(Error('Connection mutation cannot reenter its owning gate'));
    return this.enqueue('write', work, signal);
  }
  async read<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const owner = this.owner.getStore();
    if (!owner?.active) return this.enqueue('read', work, signal);
    const result = await work();
    signal?.throwIfAborted();
    if (!owner.active) throw Error('Credential read reservation expired');
    return result;
  }
  private enqueue<T>(mode: Mode, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let entered = false;
      const abort = () => {
        if (!entered) {
          const index = this.queue.indexOf(request);
          if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener('abort', abort);
          this.drain();
        }
        // Running work retains its reservation until it actually settles.
        reject(signal?.reason);
      };
      const request = {
        mode,
        begin: () => {
          entered = true;
          if (mode === 'write') this.writing = true;
          else this.readers++;
          const owner = { active: true };
          void this.owner.run(owner, async () => {
            try {
              signal?.throwIfAborted();
              const value = await work();
              signal?.throwIfAborted();
              resolve(value);
            } catch (error) {
              reject(error);
            } finally {
              owner.active = false;
              signal?.removeEventListener('abort', abort);
              if (mode === 'write') this.writing = false;
              else this.readers--;
              this.drain();
            }
          });
        },
      };
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(request);
      this.drain();
    });
  }
  private drain(): void {
    if (this.writing) return;
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.mode === 'write' && this.readers) return;
      this.queue.shift()!.begin();
      if (next.mode === 'write') return;
    }
  }
}
