import { vi } from 'vitest';
import { chatStorage, LargeChatStorage } from '../../lib/large-chat-storage';
import { IndexedChatDisk, type ChatDiskRecord } from '../../lib/indexed-chat-disk';

/** A real queued disk with an asynchronous transaction boundary and cold reopen. */
export async function durableChatStorage() {
  const records = new Map<string, ChatDiskRecord>();
  let beforeCommit = async (_record: ChatDiskRecord) => {};
  const backend = {
    read: async () => [...records.values()],
    write: async (record: ChatDiskRecord, expected: string | null, unchanged: () => boolean) => {
      await beforeCommit(record);
      if (!unchanged() || (records.get(record.key)?.revision ?? null) !== expected)
        throw Error('Draft changed in another tab');
      records.set(record.key, record);
    },
  };
  const open = () =>
    new LargeChatStorage(
      new IndexedChatDisk(localStorage, backend),
      {
        get: async () => null,
        put: async () => {
          throw Error('Unexpected legacy payload');
        },
        delete: async () => {
          throw Error('Unexpected legacy cleanup');
        },
      },
      undefined,
      Infinity,
    );
  let store = open();
  await store.ready();
  vi.spyOn(chatStorage, 'getItem').mockImplementation((key) => store.getItem(key));
  vi.spyOn(chatStorage, 'setItem').mockImplementation((key, value) => store.setItem(key, value));
  vi.spyOn(chatStorage, 'removeItem').mockImplementation((key) => store.removeItem(key));
  vi.spyOn(chatStorage, 'flush').mockImplementation(() => store.flush());
  vi.spyOn(chatStorage, 'failed', 'get').mockImplementation(() => store.failed);
  return {
    gate(callback: typeof beforeCommit) {
      beforeCommit = callback;
    },
    async reopen() {
      store = open();
      await store.ready();
    },
  };
}
