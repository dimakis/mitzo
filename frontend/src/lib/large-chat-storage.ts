import { createBrowserId } from './browser-crypto';

const PREFIX = 'mitzo-large-chat:v1:';
const THRESHOLD = 256 * 1024;
export const CHAT_STORAGE_CHANGED = 'mitzo-chat-storage-changed';
type Disk = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
interface PayloadStore {
  get(id: string): Promise<string | null>;
  put(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}
/** Synchronous editor view with an explicit durable barrier before command delivery.
 * Only small references occupy Web Storage; payloads commit to IndexedDB first.
 */
export class LargeChatStorage {
  private cache = new Map<string, { reference: string; value: string }>();
  private revisions = new Map<string, number>();
  private writes = new Map<string, { revision: number; value: string; expected: string | null }>();
  private scheduled = new Set<string>();
  private removals = new Map<string, number>();
  private errors = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private disk: Disk,
    private payloads: PayloadStore,
    private changed = () => {},
  ) {}
  get length() {
    return this.keys().length;
  }
  key(index: number) {
    return this.keys()[index] ?? null;
  }
  get pending() {
    return this.writes.size > 0 || this.removals.size > 0;
  }
  get failed() {
    return this.errors.size > 0;
  }
  keys() {
    return [
      ...new Set([
        ...Array.from({ length: this.disk.length }, (_, index) => this.disk.key(index)).filter(
          (key): key is string => key !== null,
        ),
        ...this.writes.keys(),
      ]),
    ].filter((key) => !this.removals.has(key));
  }
  async ready(): Promise<void> {
    const results = await Promise.allSettled(
      this.keys().map(async (key) => {
        const reference = this.disk.getItem(key);
        if (!reference?.startsWith(PREFIX) || this.writes.has(key)) return;
        const value = await this.payloads.get(reference.slice(PREFIX.length));
        if (this.disk.getItem(key) !== reference || this.writes.has(key)) return;
        if (value === null) throw Error('Saved chat payload is unavailable');
        this.cache.set(key, { reference, value });
      }),
    );
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  getItem(key: string): string | null {
    if (this.removals.has(key)) return null;
    const write = this.writes.get(key);
    if (write) return write.value;
    const raw = this.disk.getItem(key);
    if (!raw?.startsWith(PREFIX)) return raw;
    const cached = this.cache.get(key);
    if (!cached || cached.reference !== raw) throw Error('Saved chat payload is loading');
    return cached.value;
  }
  setItem(key: string, value: string): void {
    if (this.getReadableValue(key) === value && !this.errors.has(key)) return;
    const revision = (this.revisions.get(key) ?? 0) + 1;
    const expected = this.disk.getItem(key);
    if (value.length <= THRESHOLD && !value.startsWith(PREFIX)) {
      // A failed synchronous replacement must not invalidate an earlier save.
      this.disk.setItem(key, value);
      this.revisions.set(key, revision);
      this.errors.delete(key);
      this.writes.delete(key);
      this.removals.delete(key);
      this.cache.delete(key);
      this.clean(expected);
      return;
    }
    this.revisions.set(key, revision);
    this.errors.delete(key);
    this.removals.delete(key);
    this.writes.set(key, { revision, value, expected });
    // Register the barrier before notifying synchronous migration/save listeners.
    this.enqueueWrite(key);
    this.changed();
  }
  private enqueueWrite(key: string) {
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    // Queued closures hold only a key. The map retains one latest snapshot, plus
    // at most the one put already in flight, regardless of typing frequency.
    this.tail = this.tail.catch(() => {}).then(() => this.drainWrite(key));
  }
  private async drainWrite(key: string): Promise<void> {
    try {
      // Replacements stay inside this barrier, ahead of queued source cleanup.
      while (true) {
        const write = this.writes.get(key);
        if (!write || this.revisions.get(key) !== write.revision) return;
        const { revision, value, expected } = write;
        let id: string | undefined;
        let failed = false;
        try {
          if (this.disk.getItem(key) !== expected)
            throw Error(
              'This draft changed in another tab. Keep this window open and preserve your edits.',
            );
          id = createBrowserId();
          await this.payloads.put(id, value);
          if (this.revisions.get(key) !== revision) {
            this.clean(PREFIX + id);
            continue;
          }
          if (this.disk.getItem(key) !== expected)
            throw Error(
              'This draft changed in another tab. Keep this window open and preserve your edits.',
            );
          const reference = PREFIX + id;
          this.disk.setItem(key, reference);
          this.cache.set(key, { reference, value });
          this.writes.delete(key);
          this.errors.delete(key);
          this.clean(expected);
        } catch (error) {
          if (id) this.clean(PREFIX + id);
          if (this.revisions.get(key) === revision) {
            this.errors.set(key, error);
            failed = true;
          }
        } finally {
          this.changed();
        }
        // A notification can install a newer value even after a failed put.
        if (failed && this.revisions.get(key) === revision) return;
      }
    } finally {
      this.scheduled.delete(key);
    }
  }
  removeItem(key: string): void {
    const expected = this.disk.getItem(key);
    const revision = (this.revisions.get(key) ?? 0) + 1;
    const otherPending = [...this.writes.keys(), ...this.removals.keys()].some(
      (pendingKey) => pendingKey !== key,
    );
    if (!otherPending) {
      // A failed immediate discard must leave the pending save valid.
      this.disk.removeItem(key);
      this.revisions.set(key, revision);
      this.writes.delete(key);
      this.removals.delete(key);
      this.errors.delete(key);
      this.cache.delete(key);
      this.clean(expected);
      this.changed();
      return;
    }
    this.revisions.set(key, revision);
    this.writes.delete(key);
    this.errors.delete(key);
    // Copy/migrate and receipt handoff callers retain their durable source until
    // every preceding replacement has committed. Failed copies keep the source.
    this.removals.set(key, revision);
    this.changed();
    this.tail = this.tail
      .catch(() => {})
      .then(() => {
        if (this.revisions.get(key) !== revision) return;
        try {
          if (this.errors.size) return;
          if (this.disk.getItem(key) !== expected)
            throw Error(
              'This draft changed in another tab before cleanup. Its saved copy was kept.',
            );
          this.disk.removeItem(key);
          this.cache.delete(key);
          this.clean(expected);
        } catch (error) {
          this.errors.set(key, error);
        } finally {
          this.removals.delete(key);
          this.changed();
        }
      });
  }
  async flush(): Promise<void> {
    let current;
    do {
      current = this.tail;
      await current;
    } while (current !== this.tail);
    if (this.errors.size) throw this.errors.values().next().value;
    if (this.pending) throw Error('Chat storage has unfinished writes');
  }
  private getReadableValue(key: string) {
    try {
      return this.getItem(key);
    } catch {
      return undefined;
    }
  }
  private clean(reference: string | null) {
    if (reference?.startsWith(PREFIX))
      void this.payloads.delete(reference.slice(PREFIX.length)).catch(() => {});
  }
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('mitzo-chat-payloads', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('payloads');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(Error('Chat storage is blocked by another tab'));
    };
  }));
}
async function operation<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('payloads', mode);
    const request = run(transaction.objectStore('payloads'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error ?? Error('Chat storage write failed'));
  });
}
let instance: LargeChatStorage | undefined;
function current() {
  return (instance ??= new LargeChatStorage(
    localStorage,
    {
      get: async (id) => (await operation('readonly', (store) => store.get(id))) ?? null,
      put: async (id, value) => {
        await operation('readwrite', (store) => store.put(value, id));
      },
      delete: async (id) => {
        await operation('readwrite', (store) => store.delete(id));
      },
    },
    () => window.dispatchEvent(new Event(CHAT_STORAGE_CHANGED)),
  ));
}
// Environments without IndexedDB retain the established small Web Storage behavior.
export const chatStorage = {
  get length() {
    return typeof indexedDB === 'undefined' ? localStorage.length : current().length;
  },
  key: (index: number) =>
    typeof indexedDB === 'undefined' ? localStorage.key(index) : current().key(index),
  getItem: (key: string) =>
    typeof indexedDB === 'undefined' ? localStorage.getItem(key) : current().getItem(key),
  setItem: (key: string, value: string) =>
    typeof indexedDB === 'undefined'
      ? localStorage.setItem(key, value)
      : current().setItem(key, value),
  removeItem: (key: string) =>
    typeof indexedDB === 'undefined' ? localStorage.removeItem(key) : current().removeItem(key),
  flush: () => instance?.flush() ?? Promise.resolve(),
  get pending() {
    return instance?.pending ?? false;
  },
  get failed() {
    return instance?.failed ?? false;
  },
};
export function chatStorageKeys(): string[] {
  return Array.from({ length: chatStorage.length }, (_, index) => chatStorage.key(index)).filter(
    (key): key is string => key !== null,
  );
}
export async function initializeChatStorage(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await current().ready();
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== localStorage || !event.newValue?.startsWith(PREFIX)) return;
    void initializeChatStorage()
      .then(() => {
        window.dispatchEvent(new Event(CHAT_STORAGE_CHANGED));
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new Event('mitzo-chat-drafts-changed'));
      })
      .catch(() => window.dispatchEvent(new Event(CHAT_STORAGE_CHANGED)));
  });
