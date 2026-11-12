/** Bound read-only hydration so a suspended WebKit transaction cannot retain
 * startup or every subsequent Retry forever. Never retry mutations here.
 */
export function readChatStorage<T>(
  db: IDBDatabase,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('payloads', 'readonly');
    const request = run(tx.objectStore('payloads'));
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    };
    const timer = setTimeout(() => {
      finish(() => reject(Error('Chat storage read timed out')));
      try {
        tx.abort();
      } catch {
        // A transaction may have finished while WebKit delayed its event. Its
        // late result remains fenced; cleanup must not replace the timeout.
        console.warn('[chat-storage] read_timeout_abort_unavailable');
      }
    }, 15_000);
    tx.oncomplete = () => finish(() => resolve(request.result));
    tx.onerror = tx.onabort = () =>
      finish(() => reject(tx.error ?? Error('Chat storage read failed')));
  });
}
