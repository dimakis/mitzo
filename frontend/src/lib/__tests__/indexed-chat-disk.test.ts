import { expect, it, vi } from 'vitest';
import { IndexedChatDisk, type ChatDiskRecord } from '../indexed-chat-disk';
import { LargeChatStorage, chatStorage } from '../large-chat-storage';
import { replaceComposerDraftRevision, composerDraftRevisionKey } from '../composer-draft-proof';
import { SendOutbox } from '../../../../packages/client/src/send-outbox';
import { createReviewedOutboxStorage } from '../reviewed-outbox-storage';

function fixture() {
  const legacy = new Map([['old-draft', 'Preserve this draft']]);
  const records = new Map<string, ChatDiskRecord>();
  const disk = {
    get length() {
      return legacy.size;
    },
    key: (i: number) => [...legacy.keys()][i] ?? null,
    getItem: (key: string) => legacy.get(key) ?? null,
    setItem: vi.fn(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    }),
    removeItem: vi.fn(() => {
      throw Error('Do not remove legacy data');
    }),
  };
  const backend = {
    read: async () => [...records.values()],
    write: vi.fn(
      async (record: ChatDiskRecord, expected: string | null, legacyUnchanged: () => boolean) => {
        if (!legacyUnchanged() || (records.get(record.key)?.revision ?? null) !== expected)
          throw Error('Draft changed in another tab');
        records.set(record.key, record);
      },
    ),
  };
  return { legacy, records, disk, backend, open: () => new IndexedChatDisk(disk, backend) };
}

it('saves and cold-recovers a screenshot and outgoing copy with zero Web Storage headroom', async () => {
  const f = fixture();
  const blobs = new Map<string, string>();
  const payloads = {
    get: async (id: string) => blobs.get(id) ?? null,
    put: async (id: string, value: string) => {
      blobs.set(id, value);
    },
    delete: async (id: string) => {
      blobs.delete(id);
    },
  };
  const store = new LargeChatStorage(f.open(), payloads, undefined, Infinity);
  await store.ready();
  const draft = JSON.stringify({ text: 'Inspect screenshot', image: 'AAAA'.repeat(80000) });
  store.setItem('draft', draft);
  store.setItem('outgoing', draft);
  await store.flush();
  const cold = new LargeChatStorage(f.open(), payloads, undefined, Infinity);
  await cold.ready();
  expect(cold.getItem('draft')).toBe(draft);
  expect(cold.getItem('outgoing')).toBe(draft);
  expect(cold.getItem('old-draft')).toBe('Preserve this draft');
  expect(f.disk.setItem).not.toHaveBeenCalled();
  expect(f.disk.removeItem).not.toHaveBeenCalled();
});

it('keeps a durable tombstone so a deleted legacy draft cannot return after reload', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.removeItem('old-draft');
  await disk.flush();
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('old-draft')).toBeNull();
  expect(cold.keys()).not.toContain('old-draft');
  expect(f.legacy.get('old-draft')).toBe('Preserve this draft');
});

it('refuses a stale tab write and preserves its unsaved text and the other tab’s committed text', async () => {
  const f = fixture();
  const a = f.open(),
    b = f.open();
  await Promise.all([a.ready(), b.ready()]);
  a.setItem('old-draft', 'A');
  await a.flush();
  b.setItem('old-draft', 'B');
  await expect(b.flush()).rejects.toThrow(/another tab/);
  expect(b.getItem('old-draft')).toBe('B');
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('old-draft')).toBe('A');
  expect(b.failed).toBe(true);
});

it('coalesces typing and confirms persistence only after the database commits', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    await gate;
    await write(...args);
  });
  const disk = f.open();
  await disk.ready();
  for (let i = 0; i < 50; i++) disk.setItem('draft', `text ${i}`);
  expect(disk.pending).toBe(true);
  expect(f.records.has('draft')).toBe(false);
  release();
  await disk.flush();
  expect(f.backend.write).toHaveBeenCalledTimes(1);
  expect(f.records.get('draft')?.value).toBe('text 49');
  expect(disk.pending).toBe(false);
});

it('keeps the previous payload when its replacement reference cannot commit', async () => {
  const f = fixture();
  const blobs = new Map<string, string>();
  const payloads = {
    get: async (id: string) => blobs.get(id) ?? null,
    put: async (id: string, value: string) => {
      blobs.set(id, value);
    },
    delete: async (id: string) => {
      blobs.delete(id);
    },
  };
  const store = new LargeChatStorage(f.open(), payloads, undefined, Infinity);
  await store.ready();
  const original = 'old'.repeat(100000);
  store.setItem('draft', original);
  await store.flush();
  f.backend.write.mockRejectedValue(Error('Database unavailable'));
  store.setItem('draft', 'new'.repeat(100000));
  await expect(store.flush()).rejects.toThrow('Database unavailable');
  const cold = new LargeChatStorage(f.open(), payloads, undefined, Infinity);
  await cold.ready();
  expect(cold.getItem('draft')).toBe(original);
});

it('does not let a refresh authorize overwriting a conflicting saved edit', async () => {
  const f = fixture();
  const a = f.open(),
    b = f.open();
  await Promise.all([a.ready(), b.ready()]);
  a.setItem('old-draft', 'A');
  await a.flush();
  b.setItem('old-draft', 'B');
  await expect(b.flush()).rejects.toThrow(/another tab/);
  await b.ready();
  b.setItem('old-draft', 'B edited');
  await expect(b.flush()).rejects.toThrow(/another tab/);
  expect(f.records.get('old-draft')?.value).toBe('A');
});

it('recovers an IndexedDB failure by explicitly retrying the same value', async () => {
  const f = fixture();
  const disk = f.open();
  const store = new LargeChatStorage(
    disk,
    {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    undefined,
    Infinity,
  );
  await store.ready();
  f.backend.write.mockRejectedValueOnce(Error('Database unavailable'));
  store.setItem('draft', 'keep my text');
  await expect(store.flush()).rejects.toThrow('Database unavailable');
  expect(store.getItem('draft')).toBe('keep my text');
  store.setItem('draft', 'keep my text');
  await store.flush();
  expect(store.failed).toBe(false);
  expect(f.records.get('draft')?.value).toBe('keep my text');
});

it('preserves literal text that starts with the old payload-reference prefix', async () => {
  const f = fixture();
  const payloads = { get: async () => null, put: async () => {}, delete: async () => {} };
  const store = new LargeChatStorage(f.open(), payloads, undefined, Infinity);
  await store.ready();
  const text = 'mitzo-large-chat:v1:literal text';
  store.setItem('draft', text);
  await store.flush();
  const cold = new LargeChatStorage(f.open(), payloads, undefined, Infinity);
  await cold.ready();
  expect(cold.getItem('draft')).toBe(text);
});

it('keeps the durable migration source when its destination cannot commit', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'destination') throw Error('Copy failed');
    await write(...args);
  });
  disk.setItem('destination', disk.getItem('old-draft')!);
  disk.removeItem('old-draft');
  await expect(disk.flush()).rejects.toThrow('Copy failed');
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('old-draft')).toBe('Preserve this draft');
  expect(cold.getItem('destination')).toBeNull();
});

it('fails closed until saved IndexedDB keys have been hydrated', async () => {
  const f = fixture();
  f.backend.read = async () => {
    throw Error('Read failed');
  };
  const disk = f.open();
  await expect(disk.ready()).rejects.toThrow('Read failed');
  expect(() => disk.getItem('unknown-outgoing')).toThrow(/loading/);
  expect(() => disk.setItem('new-outgoing', 'Do not send')).toThrow(/loading/);
  expect(f.backend.write).not.toHaveBeenCalled();
});

it('waits for the real outgoing record commit before attempting delivery', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    await gate;
    await write(...args);
  });
  const fetch = vi.fn().mockRejectedValue(Error('Lost acknowledgement'));
  const outbox = new SendOutbox({
    url: 'https://offline.test/send',
    storage: createReviewedOutboxStorage(disk, 'https://offline.test/send'),
    durableLaunches: true,
    fetch,
    notify: vi.fn(),
  });
  outbox.start();
  const body = {
    type: 'send',
    sessionId: null,
    clientMsgId: 'test-command',
    prompt: 'Inspect screenshot',
  };
  try {
    expect(outbox.enqueue(body, 1)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.records.size).toBe(0);
    release();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const cold = f.open();
    await cold.ready();
    const [entry] = JSON.parse(
      createReviewedOutboxStorage(cold, 'https://offline.test/send').getItem('queue')!,
    );
    expect(entry.body).toEqual(body);
    expect(entry.uncertain).toBe(true);
  } finally {
    release();
    outbox.stop();
  }
});

it('joins overlapping startup reads so neither caller sees an uninitialized store', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.backend.read = vi.fn(async () => {
    await gate;
    return [];
  });
  const disk = f.open();
  const first = disk.ready().then(() => disk.getItem('old-draft'));
  const second = disk.ready().then(() => disk.getItem('old-draft'));
  expect(f.backend.read).toHaveBeenCalledTimes(1);
  release();
  expect(await Promise.all([first, second])).toEqual([
    'Preserve this draft',
    'Preserve this draft',
  ]);
});

it('refuses to shadow a newer draft written by an already-open older frontend', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('old-draft', 'new frontend draft');
  await disk.flush();
  f.legacy.set('old-draft', 'newer old frontend edit');
  expect(() => disk.getItem('old-draft')).toThrow(/another tab/);
  expect(() => disk.setItem('old-draft', 'overwrite')).toThrow(/another tab/);
  const cold = f.open();
  await cold.ready();
  expect(() => cold.getItem('old-draft')).toThrow(/another tab/);
  expect(f.records.get('old-draft')?.value).toBe('new frontend draft');
  expect(f.legacy.get('old-draft')).toBe('newer old frontend edit');
});

it('rejects an old-frontend edit that arrives while an existing IndexedDB record is committing', async () => {
  const f = fixture();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (!args[2]()) throw Error('Draft changed in another tab');
    await write(...args);
  });
  const disk = f.open();
  await disk.ready();
  disk.setItem('old-draft', 'first saved');
  await disk.flush();
  disk.setItem('old-draft', 'pending replacement');
  f.legacy.set('old-draft', 'old frontend edit');
  await expect(disk.flush()).rejects.toThrow(/another tab/);
  expect(f.records.get('old-draft')?.value).toBe('first saved');
});

it('commits revision revocation before its replacement so a failed same-value edit cannot revive old authority', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('revision', 'old-acceptance-proof');
  await disk.flush();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].value === 'new-proof') throw Error('Replacement failed');
    await write(...args);
  });
  disk.removeItem('revision');
  disk.setItem('revision', 'new-proof');
  await expect(disk.flush()).rejects.toThrow('Replacement failed');
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('revision')).toBeNull();
  expect(disk.getItem('revision')).toBe('new-proof');
});

it('enumerates a deleted key rewritten by an older frontend so outbox scans detect the conflict', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.removeItem('old-draft');
  await disk.flush();
  f.legacy.set('old-draft', 'newer old frontend work');
  disk.invalidateLegacy();
  expect(disk.keys()).toContain('old-draft');
  const cold = f.open();
  await cold.ready();
  expect(cold.keys()).toContain('old-draft');
  expect(() => cold.getItem('old-draft')).toThrow(/another tab/);
});

it('fences dependent same-text draft bytes when both revision writes are unavailable', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  const original = JSON.stringify({ text: 'Same text', updatedAt: 1 });
  const edited = JSON.stringify({ text: 'Same text', updatedAt: 2 });
  disk.setItem('revision', 'old-proof');
  disk.setItem('draft', original);
  await disk.flush();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'revision') throw Error('Revision storage unavailable');
    await write(...args);
  });
  disk.removeItem('revision');
  disk.setItem('revision', 'new-proof');
  disk.setItem('draft', edited);
  await expect(disk.flush()).rejects.toThrow('Revision storage unavailable');
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('draft')).toBe(original);
  expect(cold.getItem('revision')).toBe('old-proof');
  expect(disk.getItem('draft')).toBe(edited);
  expect(disk.getItem('revision')).toBeNull();
  expect(f.backend.write.mock.calls.some(([record]) => record.key === 'draft')).toBe(false);
  f.backend.write = write;
  disk.setItem('revision', 'new-proof');
  disk.setItem('draft', edited);
  await disk.flush();
  const recovered = f.open();
  await recovered.ready();
  expect(recovered.getItem('revision')).toBe('new-proof');
  expect(recovered.getItem('draft')).toBe(edited);
  expect(disk.failed).toBe(false);
});

it.each([false, true])(
  'retains an edited migration source when its copy fails (saved=%s)',
  async (saved) => {
    const f = fixture();
    const disk = f.open();
    await disk.ready();
    if (saved) {
      disk.setItem('source', 'Original');
      await disk.flush();
    }
    const write = f.backend.write;
    f.backend.write = vi.fn(async (...args) => {
      if (args[0].key === 'destination') throw Error('Copy failed');
      await write(...args);
    });
    disk.setItem('source', 'Latest edited draft');
    disk.setItem('destination', disk.getItem('source')!);
    disk.removeItem('source');
    await expect(disk.flush()).rejects.toThrow('Copy failed');
    expect(disk.getItem('source')).toBe('Latest edited draft');
    const cold = f.open();
    await cold.ready();
    expect(cold.getItem('source')).toBe('Latest edited draft');
    expect(cold.getItem('destination')).toBeNull();
    f.backend.write = write;
    disk.setItem('destination', 'Latest edited draft');
    await disk.flush();
    const recovered = f.open();
    await recovered.ready();
    expect(recovered.getItem('source')).toBeNull();
    expect(recovered.getItem('destination')).toBe('Latest edited draft');
  },
);

it('keeps a cold-recoverable source while its destination commit is paused', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('source', 'Original');
  await disk.flush();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'destination') await gate;
    await write(...args);
  });
  disk.setItem('source', 'Latest edited draft');
  disk.setItem('destination', disk.getItem('source')!);
  disk.removeItem('source');
  try {
    await vi.waitFor(() =>
      expect(f.backend.write.mock.calls.some(([r]) => r.key === 'destination')).toBe(true),
    );
    const cold = f.open();
    await cold.ready();
    expect(cold.getItem('source')).toBe('Latest edited draft');
    expect(cold.getItem('destination')).toBeNull();
  } finally {
    release();
    await disk.flush();
  }
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('source')).toBeNull();
  expect(cold.getItem('destination')).toBe('Latest edited draft');
});

it('restores the visible source after retirement fails and retries after its copy committed', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('source', 'Original');
  await disk.flush();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'source' && args[0].value === null) throw Error('Retirement failed');
    await write(...args);
  });
  disk.setItem('source', 'Latest edited draft');
  disk.setItem('destination', disk.getItem('source')!);
  disk.removeItem('source');
  await expect(disk.flush()).rejects.toThrow('Retirement failed');
  expect(disk.getItem('source')).toBe('Latest edited draft');
  expect(f.records.get('destination')?.value).toBe('Latest edited draft');
  f.backend.write = write;
  disk.removeItem('source');
  await disk.flush();
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('source')).toBeNull();
  expect(cold.getItem('destination')).toBe('Latest edited draft');
});

it('coalesces a new typing segment while an earlier snapshot is committing', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].value === 'First') await gate;
    await write(...args);
  });
  disk.setItem('draft', 'First');
  await vi.waitFor(() => expect(f.backend.write).toHaveBeenCalledTimes(1));
  for (let i = 0; i < 50; i++) disk.setItem('draft', 'Latest ' + i);
  release();
  await disk.flush();
  expect(f.backend.write).toHaveBeenCalledTimes(2);
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('draft')).toBe('Latest 49');
});

it('preserves the original CAS baseline when a failed checkpoint is retried after a foreign edit', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('revision', 'old-proof');
  disk.setItem('draft', 'Original draft');
  await disk.flush();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'revision') throw Error('Revision storage unavailable');
    await write(...args);
  });
  disk.removeItem('revision');
  disk.setItem('revision', 'new-proof');
  disk.setItem('draft', 'New draft');
  await expect(disk.flush()).rejects.toThrow('Revision storage unavailable');
  f.records.set('revision', {
    ...f.records.get('revision')!,
    revision: 'foreign',
    value: 'foreign-proof',
  });
  await disk.ready();
  f.backend.write = write;
  disk.setItem('revision', 'new-proof');
  await expect(disk.flush()).rejects.toThrow(/another tab/);
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('revision')).toBe('foreign-proof');
  expect(cold.getItem('draft')).toBe('Original draft');
});

it('rejects new intents behind a failed barrier while allowing its exact pending snapshots to retry', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('revision', 'old-proof');
  disk.setItem('draft', 'Original draft');
  await disk.flush();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'revision') throw Error('Revision storage unavailable');
    await write(...args);
  });
  disk.removeItem('revision');
  disk.setItem('revision', 'new-proof');
  disk.setItem('draft', 'Pending draft');
  await expect(disk.flush()).rejects.toThrow('Revision storage unavailable');
  for (let i = 0; i < 50; i++)
    expect(() => disk.setItem('draft', 'Unaccepted edit ' + i)).toThrow(
      'Revision storage unavailable',
    );
  expect(disk.getItem('draft')).toBe('Pending draft');
  expect(disk.getItem('revision')).toBeNull();
  f.backend.write = write;
  disk.setItem('draft', 'Pending draft');
  await disk.flush();
  disk.removeItem('revision');
  disk.setItem('revision', 'latest-proof');
  disk.setItem('draft', 'Accepted later edit');
  await disk.flush();
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('revision')).toBe('latest-proof');
  expect(cold.getItem('draft')).toBe('Accepted later edit');
  expect(disk.failed).toBe(false);
});

it('keeps revocation and body retry ordering through the public large-storage adapter', async () => {
  const f = fixture();
  const store = new LargeChatStorage(
    f.open(),
    { get: async () => null, put: async () => {}, delete: async () => {} },
    undefined,
    Infinity,
  );
  await store.ready();
  store.setItem('revision', 'old-proof');
  store.setItem('draft', 'Original draft');
  await store.flush();
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'revision') throw Error('Revision storage unavailable');
    await write(...args);
  });
  store.removeItem('revision');
  store.setItem('revision', 'new-proof');
  store.setItem('draft', 'Pending draft');
  await expect(store.flush()).rejects.toThrow('Revision storage unavailable');
  expect(store.getItem('revision')).toBeNull();
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('draft')).toBe('Original draft');
  f.backend.write = write;
  store.setItem('revision', 'new-proof');
  store.setItem('draft', 'Pending draft');
  await store.flush();
  const recovered = f.open();
  await recovered.ready();
  expect(recovered.getItem('revision')).toBe('new-proof');
  expect(recovered.getItem('draft')).toBe('Pending draft');
  expect(store.failed).toBe(false);
});

it('does not move source retirement into an already committing source snapshot', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('source', 'Original');
  await disk.flush();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'source' && args[0].value === 'Latest') await gate;
    if (args[0].key === 'destination') throw Error('Copy failed');
    await write(...args);
  });
  disk.setItem('source', 'Latest');
  await vi.waitFor(() => expect(f.backend.write).toHaveBeenCalledTimes(1));
  disk.setItem('destination', disk.getItem('source')!);
  disk.removeItem('source');
  release();
  await expect(disk.flush()).rejects.toThrow('Copy failed');
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('source')).toBe('Latest');
  expect(cold.getItem('destination')).toBeNull();
});

it('does not mutate a failed snapshot once its retry is already committing', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('draft', 'Original');
  await disk.flush();
  const write = f.backend.write;
  f.backend.write = vi.fn().mockRejectedValue(Error('Database unavailable'));
  disk.setItem('draft', 'Failed snapshot');
  await expect(disk.flush()).rejects.toThrow('Database unavailable');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.backend.write = vi.fn(async (...args) => {
    await gate;
    await write(...args);
  });
  disk.setItem('draft', 'Accepted retry');
  await vi.waitFor(() => expect(f.backend.write).toHaveBeenCalledTimes(1));
  try {
    expect(() => disk.setItem('draft', 'Not accepted during retry')).toThrow(
      'Database unavailable',
    );
  } finally {
    release();
    await disk.flush();
  }
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('draft')).toBe('Accepted retry');
  expect(disk.getItem('draft')).toBe('Accepted retry');
  expect(disk.pending).toBe(false);
  expect(disk.failed).toBe(false);
});

function routeComposerStorage(store: LargeChatStorage) {
  const spies = [
    vi.spyOn(chatStorage, 'getItem').mockImplementation((key) => store.getItem(key)),
    vi.spyOn(chatStorage, 'setItem').mockImplementation((key, value) => store.setItem(key, value)),
    vi.spyOn(chatStorage, 'removeItem').mockImplementation((key) => store.removeItem(key)),
  ];
  spies.push(
    vi
      .spyOn(chatStorage, 'setRevision')
      .mockImplementation((key, value) => store.setRevision(key, value)),
  );
  return () => spies.forEach((spy) => spy.mockRestore());
}

it('bounds real composer rich-edit snapshots behind a paused transaction and fences an earlier body', async () => {
  const f = fixture();
  const store = new LargeChatStorage(
    f.open(),
    { get: async () => null, put: async () => {}, delete: async () => {} },
    undefined,
    Infinity,
  );
  await store.ready();
  const owner = 'rich-edit-bound';
  const revision = composerDraftRevisionKey(owner);
  const image = 'AAAA'.repeat(65536);
  const body = (text: string) =>
    JSON.stringify({ text, images: [{ data: image, preview: image }] });
  store.setItem(revision, 'old-proof');
  store.setItem(owner, body('Original'));
  await store.flush();
  const restore = routeComposerStorage(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.backend.write;
  const editedAuthorities: Array<string | null> = [];
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === 'hold') await gate;
    if (args[0].key === owner && JSON.parse(args[0].value!).text.startsWith('Edit '))
      editedAuthorities.push(f.records.get(revision)?.value ?? null);
    await write(...args);
  });
  try {
    store.setItem('hold', 'Pause');
    await vi.waitFor(() => expect(f.backend.write).toHaveBeenCalledTimes(1));
    store.setItem(owner, body('Mounted original'));
    for (let i = 0; i < 50; i++) {
      expect(replaceComposerDraftRevision(owner, 'proof-' + i)).toBe(true);
      store.setItem(owner, body('Edit ' + i));
    }
    release();
    await store.flush();
    const bodies = f.backend.write.mock.calls.filter(([record]) => record.key === owner);
    expect(bodies.length).toBeLessThanOrEqual(2);
    expect(editedAuthorities).toEqual(['proof-49']);
    const cold = f.open();
    await cold.ready();
    expect(cold.getItem(owner)).toBe(body('Edit 49'));
    expect(cold.getItem(revision)).toBe('proof-49');
  } finally {
    release();
    await store.flush().catch(() => {});
    restore();
  }
});

it('bounds real composer edits during an active proof write without reviving a captured outbox proof', async () => {
  const f = fixture();
  const store = new LargeChatStorage(
    f.open(),
    { get: async () => null, put: async () => {}, delete: async () => {} },
    undefined,
    Infinity,
  );
  await store.ready();
  const owner = 'captured-edit-bound';
  const revision = composerDraftRevisionKey(owner);
  const image = 'AAAA'.repeat(65536);
  const body = (updatedAt: number) =>
    JSON.stringify({ text: 'Same text', updatedAt, images: [{ data: image, preview: image }] });
  store.setItem(revision, 'old-proof');
  store.setItem(owner, body(0));
  await store.flush();
  const restore = routeComposerStorage(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.backend.write;
  f.backend.write = vi.fn(async (...args) => {
    if (args[0].key === revision && args[0].value === 'captured-proof') await gate;
    if (args[0].key === revision && args[0].value === 'proof-50')
      throw Error('Latest proof unavailable');
    await write(...args);
  });
  try {
    expect(replaceComposerDraftRevision(owner, 'captured-proof')).toBe(true);
    store.setItem(owner, body(1));
    await vi.waitFor(() =>
      expect(f.backend.write.mock.calls.some(([r]) => r.value === 'captured-proof')).toBe(true),
    );
    // A frozen queued command can survive a crash even before HTTP starts.
    store.setItem('outgoing-proof', 'captured-proof');
    for (let i = 2; i <= 50; i++) {
      expect(replaceComposerDraftRevision(owner, 'proof-' + i)).toBe(true);
      store.setItem(owner, body(i));
    }
    release();
    await expect(store.flush()).rejects.toThrow('Latest proof unavailable');
    const cold = f.open();
    await cold.ready();
    const proof = cold.getItem(revision);
    if (proof === cold.getItem('outgoing-proof')) expect(cold.getItem(owner)).toBe(body(1));
    expect(f.backend.write.mock.calls.filter(([r]) => r.key === owner).length).toBeLessThanOrEqual(
      2,
    );
    f.backend.write = write;
    store.setItem(revision, 'proof-50');
    store.setItem(owner, body(50));
    await store.flush();
    const recovered = f.open();
    await recovered.ready();
    expect(recovered.getItem(revision)).toBe('proof-50');
    expect(recovered.getItem(owner)).toBe(body(50));
    expect(recovered.getItem('outgoing-proof')).not.toBe(recovered.getItem(revision));
  } finally {
    release();
    await store.flush().catch(() => {});
    restore();
  }
});

it('hides a failed ordinary snapshot when an atomic proof replacement retries it', async () => {
  const f = fixture();
  const disk = f.open();
  await disk.ready();
  disk.setItem('proof', 'old-proof');
  await disk.flush();
  f.backend.write.mockRejectedValue(Error('Unavailable'));
  disk.setItem('proof', 'failed ordinary snapshot');
  await expect(disk.flush()).rejects.toThrow('Unavailable');
  disk.setRevision('proof', 'new-proof');
  await expect(disk.flush()).rejects.toThrow('Unavailable');
  expect(disk.getItem('proof')).toBeNull();
  const cold = f.open();
  await cold.ready();
  expect(cold.getItem('proof')).toBe('old-proof');
});
