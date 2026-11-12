// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { chatStorage } from '../../lib/large-chat-storage';
import { useQueuedMessages } from '../useQueuedMessages';

const disk = vi.hoisted(() => ({
  fail: false,
  records: new Map<string, string>(),
  payloads: new Map<string, string>(),
}));
vi.mock('../../lib/large-chat-storage', async (original) => {
  const actual = await original<typeof import('../../lib/large-chat-storage')>();
  const storage = new actual.LargeChatStorage(
    {
      get length() {
        return disk.records.size;
      },
      key: (i: number) => [...disk.records.keys()][i] ?? null,
      getItem: (key: string) => disk.records.get(key) ?? null,
      setItem: (key: string, value: string) => {
        disk.records.set(key, value);
      },
      removeItem: (key: string) => {
        disk.records.delete(key);
      },
    },
    {
      get: async (id: string) => disk.payloads.get(id) ?? null,
      put: async (id: string, value: string) => {
        if (disk.fail) throw Error('injected disk write failure');
        disk.payloads.set(id, value);
      },
      delete: async (id: string) => {
        disk.payloads.delete(id);
      },
    },
    () => {},
    1,
  );
  return { ...actual, chatStorage: storage };
});
afterEach(cleanup);

it('explicitly rewrites the queue after a real failed payload write rather than only re-flushing its retained error', async () => {
  const entries = ['First', 'Second'].map((text, i) => ({
    queueEntryId: 'retry-' + i,
    text,
    images: [],
    contextBlocks: [],
  }));
  chatStorage.setItem('mitzo-queue-real-retry', JSON.stringify(entries));
  await chatStorage.flush();
  const hook = renderHook(() => useQueuedMessages('real-retry'));
  disk.fail = true;
  act(() => expect(hook.result.current.update(1, hook.result.current.queue[1], 0)).toBe(true));
  await expect(chatStorage.flush()).rejects.toThrow('injected disk write failure');
  disk.fail = false;
  await expect(chatStorage.flush()).rejects.toThrow('injected disk write failure');
  await act(async () => expect(await hook.result.current.retryPersistence()).toBe(true));
  expect(chatStorage.failed).toBe(false);
  expect(
    JSON.parse(chatStorage.getItem('mitzo-queue-real-retry')!).map((q: { text: string }) => q.text),
  ).toEqual(['Second', 'First']);
});
