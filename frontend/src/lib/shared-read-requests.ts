/** Shares only outstanding read requests. Each consumer retains cancellation;
 * no settled response, permission result or credential proof is cached here. */
export class SharedReadRequests {
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<Response>; users: number }
  >();
  private active = new Set<{
    controller: AbortController;
    promise: Promise<Response>;
    users: number;
  }>();
  retire(): void {
    this.pending.clear();
  }
  clear(): void {
    for (const request of this.active) request.controller.abort();
    this.active.clear();
    this.pending.clear();
  }
  read(
    key: string,
    loader: (signal: AbortSignal) => Promise<Response>,
    signal?: AbortSignal | null,
  ): Promise<Response> {
    signal?.throwIfAborted();
    let request = this.pending.get(key);
    if (!request) {
      const controller = new AbortController();
      const promise = loader(controller.signal);
      const created = { controller, users: 0, promise };
      created.promise = promise.finally(() => {
        this.active.delete(created);
        if (this.pending.get(key) === created) this.pending.delete(key);
      });
      request = created;
      this.active.add(created);
      this.pending.set(key, request);
    }
    const selected = request;
    selected.users++;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = (cancel = false) => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', abort);
        selected.controller.signal.removeEventListener('abort', abort);
        if (--selected.users === 0) {
          if (this.pending.get(key) === selected) this.pending.delete(key);
          if (cancel) {
            this.active.delete(selected);
            selected.controller.abort();
          }
        }
        return true;
      };
      const abort = () => {
        if (finish(true)) reject(new DOMException('Read cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      selected.controller.signal.addEventListener('abort', abort, { once: true });
      selected.promise.then(
        (response) => {
          if (settled) return;
          try {
            const copy = response.clone();
            if (finish()) resolve(copy);
          } catch (error) {
            if (finish()) reject(error);
          }
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  }
}
