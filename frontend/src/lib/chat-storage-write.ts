export class ChatStorageWriteTimeout extends Error {
  constructor() {
    super('Chat storage write timed out');
    this.name = 'ChatStorageWriteTimeout';
  }
}

/** A stalled WebKit write must release its queue before the outgoing-command
 * deadline. Retain the intent; this helper never retries a mutation itself.
 */
export function writeChatStorage<T>(
  db: IDBDatabase,
  run: (
    store: IDBObjectStore,
    current: () => boolean,
    fail: (cause: unknown) => void,
  ) => IDBRequest<T>,
  retire: (db: IDBDatabase) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('payloads', 'readwrite');
    let settled = false;
    let request: IDBRequest<T>;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ChatStorageWriteTimeout()));
      try {
        tx.abort();
      } catch {
        // A commit may have finished while WebKit delayed its acknowledgement.
        console.warn('[chat-storage] write_timeout_abort_unavailable');
      }
      try {
        retire(db);
      } catch {
        console.warn('[chat-storage] write_timeout_retirement_unavailable');
      }
    }, 10_000);
    tx.oncomplete = () => finish(() => resolve(request.result));
    tx.onerror = tx.onabort = () =>
      finish(() => reject(tx.error ?? Error('Chat storage write failed')));
    const fail = (cause: unknown) => {
      finish(() => reject(cause));
      try {
        tx.abort();
      } catch {
        console.warn('[chat-storage] write_failure_abort_unavailable');
      }
    };
    try {
      request = run(tx.objectStore('payloads'), () => !settled, fail);
    } catch (cause) {
      fail(cause);
    }
  });
}
