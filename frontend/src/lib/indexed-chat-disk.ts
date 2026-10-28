import { createBrowserId } from './browser-crypto';

type LegacyDisk = Pick<Storage, 'length' | 'key' | 'getItem'>;
export interface ChatDiskRecord {
  key: string;
  value: string | null;
  revision: string;
  legacy: string | null;
}
type PendingWrite = { record: ChatDiskRecord; legacy: string | null };
interface Backend {
  read(): Promise<ChatDiskRecord[]>;
  write(
    record: ChatDiskRecord,
    expected: string | null,
    legacyUnchanged: () => boolean,
  ): Promise<void>;
}
const conflict = () =>
  Error('This draft changed in another tab. Keep this window open and preserve your edits.');

/** Durable logical keys live in IndexedDB too. Legacy Web Storage is read-only:
 * tombstones hide old records without deleting the last recoverable legacy copy.
 */
export class IndexedChatDisk {
  private records = new Map<string, ChatDiskRecord>();
  private writes = new Map<string, PendingWrite>();
  private revocations = new Map<string, PendingWrite>();
  private errors = new Map<string, unknown>();
  private scheduled = new Set<string>();
  private reading: Promise<void> | undefined;
  private initialized = false;
  private keyCache: string[] | undefined;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private legacy: LegacyDisk,
    private backend: Backend,
    private changed = () => {},
  ) {}
  get pending() {
    return this.writes.size > 0;
  }
  get failed() {
    return this.errors.size > 0;
  }
  get length() {
    return this.keys().length;
  }
  key(index: number) {
    return this.keys()[index] ?? null;
  }
  keys() {
    return (this.keyCache ??= [
      ...new Set([
        ...Array.from({ length: this.legacy.length }, (_, i) => this.legacy.key(i)).filter(
          (key): key is string => key !== null,
        ),
        ...this.records.keys(),
        ...this.writes.keys(),
      ]),
    ].filter((key) => {
      const record = this.writes.get(key)?.record ?? this.records.get(key);
      return record
        ? record.value !== null || this.legacy.getItem(key) !== record.legacy
        : this.legacy.getItem(key) !== null;
    }));
  }
  invalidateLegacy() {
    this.keyCache = undefined;
  }
  ready(): Promise<void> {
    return (this.reading ??= this.hydrate().finally(() => {
      this.reading = undefined;
    }));
  }
  private async hydrate() {
    const baseline = new Map(this.records);
    const records = await this.backend.read();
    this.initialized = true;
    this.keyCache = undefined;
    const snapshot = new Map(records.map((record) => [record.key, record]));
    for (const key of new Set([...baseline.keys(), ...this.records.keys(), ...snapshot.keys()])) {
      // A refresh cannot advance the baseline of an unsaved edit or undo a
      // commit that finished while this read was in flight.
      if (this.writes.has(key) || this.records.get(key) !== baseline.get(key)) continue;
      const record = snapshot.get(key);
      if (record) this.records.set(key, record);
      else this.records.delete(key);
    }
  }
  isLegacy(key: string) {
    return !this.writes.has(key) && !this.records.has(key);
  }
  getItem(key: string): string | null {
    if (!this.initialized) throw Error('Saved chat storage is loading');
    const record = this.writes.get(key)?.record ?? this.records.get(key);
    if (record && this.legacy.getItem(key) !== record.legacy) throw conflict();
    return record ? record.value : this.legacy.getItem(key);
  }
  setItem(key: string, value: string) {
    this.replace(key, value);
  }
  removeItem(key: string) {
    this.replace(key, null);
  }
  private replace(key: string, value: string | null) {
    if (this.getItem(key) === value && !this.errors.has(key)) return;
    this.keyCache = undefined;
    const previous = this.writes.get(key);
    // removeItem revokes existing authority before a replacement. Keep one
    // deletion checkpoint even when rapid edits coalesce their later values.
    if (previous?.record.value === null && value !== null && !this.revocations.has(key))
      this.revocations.set(key, previous);
    this.writes.set(key, {
      record: { key, value, revision: createBrowserId(), legacy: this.legacy.getItem(key) },
      legacy: this.legacy.getItem(key),
    });
    this.errors.delete(key);
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        try {
          while (true) {
            const revocation = this.revocations.get(key);
            const write = revocation ?? this.writes.get(key);
            if (!write) return;
            const expected = this.records.get(key)?.revision ?? null;
            let failed = false;
            try {
              // Copy and acceptance callers enqueue source retirement after the
              // replacement. A failed preceding write must retain that source.
              if (
                write.record.value === null &&
                [...this.errors.keys()].some((other) => other !== key)
              )
                throw Error('Chat source retained because an earlier save failed');
              await this.backend.write(
                write.record,
                expected,
                () => this.legacy.getItem(key) === write.legacy,
              );
              this.records.set(key, write.record);
              if (revocation) this.revocations.delete(key);
              else if (this.writes.get(key) === write) this.writes.delete(key);
              this.errors.delete(key);
            } catch (error) {
              if (revocation) this.revocations.delete(key);
              if (this.writes.get(key) === write) {
                this.errors.set(key, error);
                if (write.record.value === null) {
                  this.writes.delete(key);
                  this.keyCache = undefined;
                }
                failed = true;
              }
            } finally {
              this.changed();
            }
            if (failed && this.writes.get(key) === write) return;
          }
        } finally {
          this.scheduled.delete(key);
        }
      });
    this.changed();
  }
  async flush() {
    let tail;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
    if (this.errors.size) throw this.errors.values().next().value;
    if (this.pending) throw Error('Chat storage has unfinished writes');
  }
}

const PREFIX = 'chat-record:v1:';
const recordKey = (key: string) => PREFIX + encodeURIComponent(key);
export function createIndexedChatDisk(
  legacy: LegacyDisk,
  open: () => Promise<IDBDatabase>,
  committed: () => void,
  changed: () => void,
) {
  return new IndexedChatDisk(
    legacy,
    {
      async read() {
        const db = await open();
        return new Promise<ChatDiskRecord[]>((resolve, reject) => {
          const tx = db.transaction('payloads', 'readonly');
          const request = tx
            .objectStore('payloads')
            .getAll(IDBKeyRange.bound(PREFIX, PREFIX + '\uffff'));
          tx.oncomplete = () => {
            const records: unknown[] = request.result;
            if (records.some((record) => !validRecord(record)))
              reject(Error('Saved chat index is invalid'));
            else resolve(records as ChatDiskRecord[]);
          };
          tx.onerror = tx.onabort = () => reject(tx.error ?? Error('Chat storage read failed'));
        });
      },
      async write(record, expected, legacyUnchanged) {
        const db = await open();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('payloads', 'readwrite');
          const store = tx.objectStore('payloads');
          const read = store.get(recordKey(record.key));
          let error: unknown;
          read.onsuccess = () => {
            const current: unknown = read.result;
            if (
              (current !== undefined && !validRecord(current)) ||
              ((current as ChatDiskRecord | undefined)?.revision ?? null) !== expected ||
              !legacyUnchanged()
            ) {
              error = conflict();
              tx.abort();
            } else {
              try {
                store.put(record, recordKey(record.key));
              } catch (cause) {
                error = cause;
                tx.abort();
              }
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () =>
            reject(error ?? tx.error ?? Error('Chat storage write failed'));
        });
        // Notifications do not change the outcome of a committed transaction.
        try {
          committed();
        } catch {
          /* A suspended tab will refresh on resume. */
        }
      },
    },
    changed,
  );
}
function validRecord(value: unknown): value is ChatDiskRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as ChatDiskRecord;
  return (
    typeof record.key === 'string' &&
    typeof record.revision === 'string' &&
    (record.legacy === null || typeof record.legacy === 'string') &&
    (record.value === null || typeof record.value === 'string')
  );
}
