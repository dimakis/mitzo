import { createBrowserId } from './browser-crypto';

type LegacyDisk = Pick<Storage, 'length' | 'key' | 'getItem'>;
export interface ChatDiskRecord {
  key: string;
  value: string | null;
  revision: string;
  legacy: string | null;
}
type PendingWrite = {
  record: ChatDiskRecord;
  legacy: string | null;
  checkpoint?: boolean;
  authority?: boolean;
};
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
  private queued = new Map<string, PendingWrite>();
  private coalescible = new Map<string, PendingWrite>();
  private queue: PendingWrite[] = [];
  private errors = new Map<string, unknown>();
  private failedWrite: PendingWrite | undefined;
  private draining = false;
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
    return this.queue.length > 0;
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
      if (this.queued.has(key) || this.records.get(key) !== baseline.get(key)) continue;
      const record = snapshot.get(key);
      if (record) this.records.set(key, record);
      else this.records.delete(key);
    }
  }
  isLegacy(key: string) {
    return !this.writes.has(key) && !this.records.has(key);
  }
  getItem(key: string): string | null {
    const value = this.readValue(key);
    // A failed revocation never exposes cached replacement authority.
    return (this.failedWrite?.checkpoint || this.failedWrite?.authority) &&
      this.failedWrite.record.key === key
      ? null
      : value;
  }
  private readValue(key: string): string | null {
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
  /** A fresh composer proof must precede its payload. Coalesce only while its
   * proof slot is mutable; once it starts, freeze earlier body snapshots too.
   */
  setRevision(key: string, value: string) {
    if (!this.coalescible.has(key)) this.coalescible.clear();
    this.replace(key, value, true);
  }
  private replace(key: string, value: string | null, authority = false) {
    const current = this.readValue(key);
    if (this.errors.size) {
      const failed = this.failedWrite!;
      // With no followers, a failed non-destructive snapshot is still one
      // typing segment. Revise its value without refreshing its CAS baseline.
      if (
        !this.draining &&
        this.queue.length === 1 &&
        failed.record.key === key &&
        failed.record.value !== null &&
        value !== null
      ) {
        failed.record = { ...failed.record, value, revision: createBrowserId() };
        if (authority) failed.authority = true;
        this.writes.set(key, failed);
        this.keyCache = undefined;
        this.schedule();
        this.changed();
        return;
      }
      const retry =
        current === value ||
        (failed.record.key === key &&
          failed.record.value === value &&
          this.queued.get(key) === failed);
      // Explicit saves retry the original failed operation first. Do not accept
      // new snapshots behind an unresolved barrier or grow an offline backlog.
      this.schedule();
      if (!retry) throw this.errors.values().next().value;
      if (failed.record.key === key && this.queued.get(key) === failed) {
        this.writes.set(key, failed);
        this.keyCache = undefined;
      }
      this.changed();
      return;
    }
    if (current === value) return;
    this.keyCache = undefined;
    const previous = this.queued.get(key);
    if (previous?.record.value === null && value !== null) previous.checkpoint = true;
    const legacy = this.legacy.getItem(key);
    const record = { key, value, revision: createBrowserId(), legacy };
    // Every deletion closes the coalescing segment for every key: a later edit
    // cannot move a retirement ahead of its copy, or payload bytes ahead of a
    // revision revocation. Ordinary typing within a segment still coalesces.
    if (value === null) this.coalescible.clear();
    const existing = value === null ? undefined : this.coalescible.get(key);
    const write = existing ?? { record, legacy };
    if (existing) existing.record = record;
    else this.queue.push(write);
    if (authority) write.authority = true;
    if (value !== null) this.coalescible.set(key, write);
    this.queued.set(key, write);
    this.writes.set(key, write);
    this.schedule();
    this.changed();
  }
  private schedule() {
    if (this.draining || !this.queue.length) return;
    this.draining = true;
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        try {
          while (this.queue.length) {
            const write = this.queue[0];
            const key = write.record.key;
            if (this.coalescible.get(key) === write) this.coalescible.delete(key);
            try {
              await this.backend.write(
                write.record,
                this.records.get(key)?.revision ?? null,
                () => this.legacy.getItem(key) === write.legacy,
              );
              this.records.set(key, write.record);
              this.queue.shift();
              if (this.queued.get(key) === write) this.queued.delete(key);
              if (this.writes.get(key) === write) this.writes.delete(key);
              this.errors.delete(key);
              if (this.failedWrite === write) this.failedWrite = undefined;
            } catch (error) {
              // Keep the failed operation at the head. Followers remain pending,
              // with no independent errors that could deadlock its ordered retry.
              this.failedWrite = write;
              this.errors.set(key, error);
              // No queued retirement committed after this failure. Restore its
              // durable editor view, keeping the ordered operation for retry.
              for (const pending of this.queue)
                if (
                  pending.record.value === null &&
                  this.writes.get(pending.record.key) === pending
                )
                  this.writes.delete(pending.record.key);
              return;
            } finally {
              this.keyCache = undefined;
              this.changed();
            }
          }
        } finally {
          this.draining = false;
        }
      });
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
