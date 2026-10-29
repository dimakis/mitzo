import { expect, type Page } from '@playwright/test';

/** Inspect durable bytes through the new record layout and retained legacy layout.
 * Existing browser assertions stay about exact saved drafts/commands, independent
 * of whether the browser could fit their old Web Storage representation.
 */
export async function readChatStorage<T, A = undefined>(
  page: Page,
  read: (storage: Pick<Storage, 'getItem' | 'key' | 'length'>, argument: A) => T,
  argument?: A,
): Promise<Awaited<T>> {
  const snapshot = await page.evaluate(async () => {
    const legacy = Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!]),
    );
    if (typeof indexedDB === 'undefined') return legacy;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mitzo-chat-payloads', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('payloads');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const values = await new Promise<Map<IDBValidKey, unknown>>((resolve, reject) => {
        const tx = db.transaction('payloads', 'readonly');
        const store = tx.objectStore('payloads');
        const keys = store.getAllKeys(),
          records = store.getAll();
        tx.oncomplete = () =>
          resolve(new Map(keys.result.map((key, i) => [key, records.result[i]])));
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      const result = { ...legacy };
      for (const [key, value] of Object.entries(legacy)) {
        if (!value.startsWith('mitzo-large-chat:v1:')) continue;
        if (values.has('chat-record:v1:' + encodeURIComponent(key))) continue;
        const payload = values.get(value.slice('mitzo-large-chat:v1:'.length));
        if (typeof payload !== 'string') throw Error('Saved legacy payload is unavailable');
        result[key] = payload;
      }
      for (const [key, raw] of values) {
        if (typeof key !== 'string' || !key.startsWith('chat-record:v1:')) continue;
        const record = raw as { key: string; value: string | null; legacy: string | null };
        if ((legacy[record.key] ?? null) !== record.legacy)
          throw Error('Legacy chat record changed');
        if (record.value === null) delete result[record.key];
        else result[record.key] = record.value;
      }
      return result;
    } finally {
      db.close();
    }
  });
  const storage = Object.assign(Object.create(null), snapshot);
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => (Object.hasOwn(snapshot, key) ? snapshot[key] : null) },
    key: { value: (index: number) => Object.keys(snapshot)[index] ?? null },
    length: { value: Object.keys(snapshot).length },
  });
  return await read(storage, argument as A);
}

/** Explicit fixture setup in the durable layout; callers reload before adoption. */
export async function writeChatStorage(page: Page, key: string, value: string) {
  await page.evaluate(
    async ({ key, value }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('mitzo-chat-payloads', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('payloads');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('payloads', 'readwrite');
          const store = tx.objectStore('payloads');
          const id = 'chat-record:v1:' + encodeURIComponent(key);
          const read = store.get(id);
          read.onsuccess = () =>
            store.put(
              {
                key,
                value,
                revision: crypto.randomUUID(),
                legacy: read.result ? read.result.legacy : localStorage.getItem(key),
              },
              id,
            );
          tx.oncomplete = () => resolve();
          tx.onabort = tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { key, value },
  );
}

/** Resolve only the exact session owner, preserving the app's plain-draft
 * priority and its two-sided rich-draft binding fence. Never search by text.
 */
export function persistedChatDraftText(
  storage: Pick<Storage, 'getItem'>,
  id: string,
): string | null {
  const plain = storage.getItem('mitzo-draft-' + id);
  if (plain !== null) return plain;
  try {
    const binding = (raw: string | null) => {
      const value = JSON.parse(raw ?? 'null');
      return value?.version === 1 &&
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0 &&
        typeof value.draftId === 'string' &&
        value.draftId.length > 0 &&
        Object.keys(value).length === 3
        ? (value as { version: 1; sessionId: string; draftId: string })
        : null;
    };
    const target = binding(storage.getItem('mitzo-chat-draft-session:' + encodeURIComponent(id)));
    if (!target || target.sessionId !== id) return null;
    const source = binding(
      storage.getItem('mitzo-chat-draft-assignment:' + encodeURIComponent(target.draftId)),
    );
    if (!source || source.sessionId !== id || source.draftId !== target.draftId) return null;
    const draft = JSON.parse(storage.getItem('mitzo-chat-draft:' + target.draftId) ?? 'null');
    return draft?.version === 1 && draft.id === target.draftId && typeof draft.text === 'string'
      ? draft.text
      : null;
  } catch {
    return null;
  }
}

/** Fixture setup only: confirm an unsent isolation control before its document
 * is destroyed. Actual send, crash and recovery assertions keep their own timing.
 */
export async function expectPersistedChatDraft(page: Page, id: string, text: string) {
  await expect.poll(() => readChatStorage(page, persistedChatDraftText, id)).toBe(text);
}
