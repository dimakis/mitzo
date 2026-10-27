import { expect, it } from 'vitest';
import { LargeChatStorage } from '../large-chat-storage';
function fixture() {
  const disk = new Map<string, string>();
  const blobs = new Map<string, string>();
  const storage = {
    get length() {
      return disk.size;
    },
    key: (i: number) => [...disk.keys()][i] ?? null,
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > 1000) throw Error('Quota exceeded');
      disk.set(key, value);
    },
    removeItem: (key: string) => {
      disk.delete(key);
    },
  };
  const backend = {
    get: async (id: string) => blobs.get(id) ?? null,
    put: async (id: string, value: string) => {
      blobs.set(id, value);
    },
    delete: async (id: string) => {
      blobs.delete(id);
    },
  };
  return { disk, blobs, storage, backend };
}
it('retains large drafts and commands beyond localStorage quota and reloads their exact bytes', async () => {
  const f = fixture();
  const first = new LargeChatStorage(f.storage, f.backend);
  const value = JSON.stringify({
    text: 'Long text'.repeat(150000),
    images: ['AAAA'.repeat(300000)],
  });
  first.setItem('draft', value);
  expect(first.getItem('draft')).toBe(value);
  await first.flush();
  expect(f.disk.get('draft')!.length).toBeLessThan(1000);
  const cold = new LargeChatStorage(f.storage, f.backend);
  expect(() => cold.getItem('draft')).toThrow(/loading/);
  await cold.ready();
  expect(cold.getItem('draft')).toBe(value);
});
it('does not confirm persistence when the database write fails', async () => {
  const f = fixture();
  f.backend.put = async () => {
    throw Error('Disk full');
  };
  const store = new LargeChatStorage(f.storage, f.backend);
  store.setItem('draft', 'x'.repeat(300000));
  await expect(store.flush()).rejects.toThrow('Disk full');
  expect(f.disk.has('draft')).toBe(false);
  expect(store.getItem('draft')).toHaveLength(300000);
});
it('does not resurrect a removed draft when an earlier database write finishes', async () => {
  const f = fixture();
  const store = new LargeChatStorage(f.storage, f.backend);
  store.setItem('draft', 'x'.repeat(300000));
  store.removeItem('draft');
  await store.flush();
  expect(store.getItem('draft')).toBeNull();
  expect(f.disk.has('draft')).toBe(false);
});

it('keeps the durable source when an asynchronous migration copy fails', async () => {
  const f = fixture();
  const store = new LargeChatStorage(f.storage, f.backend);
  store.setItem('source', 'original'.repeat(50000));
  await store.flush();
  const originalPointer = f.disk.get('source');
  f.backend.put = async () => {
    throw Error('Disk full');
  };
  store.setItem('destination', store.getItem('source')!);
  store.removeItem('source');
  expect(f.disk.get('source')).toBe(originalPointer);
  await expect(store.flush()).rejects.toThrow('Disk full');
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('source')).toBe('original'.repeat(50000));
});
it('does not invalidate a pending large save when a small replacement throws', async () => {
  const f = fixture();
  const originalSet = f.storage.setItem;
  f.storage.setItem = (key, value) => {
    if (value === 'small') throw Error('Quota');
    originalSet(key, value);
  };
  const store = new LargeChatStorage(f.storage, f.backend);
  store.setItem('draft', 'large'.repeat(60000));
  expect(() => store.setItem('draft', 'small')).toThrow('Quota');
  await store.flush();
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('draft')).toBe('large'.repeat(60000));
  expect(store.pending).toBe(false);
});
it('refuses a delayed write that would replace another tab’s newer committed draft', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = new LargeChatStorage(f.storage, {
    ...f.backend,
    put: async (id, value) => {
      await gate;
      await f.backend.put(id, value);
    },
  });
  const b = new LargeChatStorage(f.storage, f.backend);
  a.setItem('draft', 'a'.repeat(300000));
  b.setItem('draft', 'b'.repeat(300000));
  await b.flush();
  release();
  await expect(a.flush()).rejects.toThrow(/another tab|changed/);
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('draft')).toBe('b'.repeat(300000));
  expect(a.getItem('draft')).toBe('a'.repeat(300000));
});

it('does not remove a newer foreign draft while delayed migration cleanup waits', async () => {
  const f = fixture();
  const a = new LargeChatStorage(f.storage, f.backend);
  const original = 'original'.repeat(50000);
  a.setItem('source', original);
  await a.flush();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = f.backend.put;
  f.backend.put = async (id, value) => {
    if (value === original) await gate;
    await put(id, value);
  };
  a.setItem('destination', original);
  a.removeItem('source');
  const b = new LargeChatStorage(f.storage, f.backend);
  b.setItem('source', 'newer edit'.repeat(40000));
  await b.flush();
  release();
  await expect(a.flush()).rejects.toThrow(/another tab/);
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('source')).toBe('newer edit'.repeat(40000));
  expect(cold.getItem('destination')).toBe(original);
});

it('preserves a pending save when an immediate native removal throws', async () => {
  const f = fixture();
  f.storage.removeItem = () => {
    throw Error('Storage unavailable');
  };
  const store = new LargeChatStorage(f.storage, f.backend);
  store.setItem('draft', 'large'.repeat(60000));
  expect(() => store.removeItem('draft')).toThrow('Storage unavailable');
  await store.flush();
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('draft')).toBe('large'.repeat(60000));
});
