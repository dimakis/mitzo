/** Subscribe before reading to avoid a lost wakeup. No repeated model calls or retained timers. */
export function waitForChange<T>(options: {
  signal: AbortSignal;
  timeoutMs: number;
  subscribe(wake: () => void): () => void;
  read(): T;
  changed(value: T): boolean;
}): Promise<{ changed: boolean; value: T }> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let closed = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      closed = true;
      unsubscribe();
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(options.signal.reason);
    };
    const check = (timeout = false) => {
      if (closed) return;
      try {
        options.signal.throwIfAborted();
        const value = options.read();
        const changed = options.changed(value);
        if (changed || timeout) {
          cleanup();
          resolve({ changed, value });
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    try {
      unsubscribe = options.subscribe(() => check());
      if (closed) {
        unsubscribe();
        return;
      }
      options.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => check(true), options.timeoutMs);
      check();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
