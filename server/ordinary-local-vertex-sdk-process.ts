import type { ProtectedSdkProcess } from './credential-sdk-boundary.js';
/** One already-owned SDK process only; exit/error/kill flags are not close proof. */
export function observeOrdinarySdkProcessClose(process: ProtectedSdkProcess) {
  let closed = false;
  const waiters = new Set<() => void>();
  process.once('close', () => {
    closed = true;
    for (const resolve of waiters) resolve();
    waiters.clear();
  });
  return {
    wait(signal: AbortSignal, timeoutMs = 12_000): Promise<void> {
      signal.throwIfAborted();
      if (closed) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          waiters.delete(finish);
        };
        const finish = () => {
          clean();
          resolve();
        };
        const abort = () => {
          clean();
          reject(Error('Original SDK process closure unavailable'));
        };
        const timer = setTimeout(abort, timeoutMs);
        waiters.add(finish);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else if (closed) finish();
      });
    },
  };
}
