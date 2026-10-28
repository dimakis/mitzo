import { expect, it, vi } from 'vitest';
import { SendOutbox } from '../../../../packages/client/src/send-outbox';
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

it('coalesces queued attachment draft edits before allocating payloads', async () => {
  const f = fixture();
  const put = vi.fn(f.backend.put);
  const store = new LargeChatStorage(f.storage, { ...f.backend, put });
  const body = 'image-payload'.repeat(25000);
  for (let edit = 0; edit < 50; edit++) store.setItem('draft', body + edit);
  await store.flush();
  expect(put).toHaveBeenCalledTimes(1);
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('draft') === body + 49).toBe(true);
});

it('keeps migration cleanup behind the latest replacement of an in-flight destination', async () => {
  const f = fixture();
  const store = new LargeChatStorage(f.storage, f.backend);
  const source = 'source'.repeat(50000);
  store.setItem('source', source);
  await store.flush();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written: string[] = [];
  const put = f.backend.put;
  f.backend.put = async (id, value) => {
    written.push(value.slice(-10));
    if (written.length === 1) await gate;
    await put(id, value);
  };
  // The store retains the backend object, so this starts the first real put.
  store.setItem('destination', source + 'old');
  await vi.waitFor(() => expect(written).toHaveLength(1));
  for (let edit = 0; edit < 20; edit++) store.setItem('destination', source + edit);
  store.removeItem('source');
  const originalRemove = f.storage.removeItem;
  f.storage.removeItem = (key) => {
    if (key === 'source') expect(written.at(-1)).toBe((source + 19).slice(-10));
    originalRemove(key);
  };
  release();
  await store.flush();
  expect(written).toHaveLength(2);
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('source')).toBeNull();
  expect(cold.getItem('destination') === source + 19).toBe(true);
});

it.each(['missing', 'unreadable'] as const)(
  'settles a slow valid Local outbox hydration before propagating an unrelated %s payload',
  async (failure) => {
    const f = fixture();
    const key = 'mitzo-send-outbox:/local/send';
    const command = {
      runOn: 'local',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      clientMsgId: 'retained-command',
      capabilityRevision: 'caps-r1',
      runtime: {
        account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'r1' },
        harness: 'codex',
        targetId: 'mac',
        mode: 'agent',
      },
      selection: {
        version: 1,
        agent: { profileId: 'agent', revision: 1 },
        model: 'luna-fixture',
        thinking: 'low',
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
      },
      payload: { text: 'saved'.repeat(60000) },
    };
    f.disk.set('bad-draft', 'mitzo-large-chat:v1:missing');
    f.disk.set(key, 'mitzo-large-chat:v1:good');
    f.blobs.set('good', JSON.stringify([{ body: command, scope: 1, uncertain: true }]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new LargeChatStorage(f.storage, {
      ...f.backend,
      get: async (id) => {
        if (id === 'good') await gate;
        if (id === 'missing' && failure === 'unreadable') throw Error('Unreadable payload');
        return f.backend.get(id);
      },
    });
    const settled = vi.fn();
    const ready = store.ready();
    void ready.then(
      () => settled(),
      () => settled(),
    );
    // Let all currently runnable hydration promises settle, without releasing good.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      expect(settled).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await expect(ready).rejects.toThrow(/unavailable|Unreadable/);
    const notify = vi.fn();
    const fetch = vi.fn();
    const outbox = new SendOutbox({
      url: '/local/send',
      storage: store,
      fetch,
      notify,
      localFirstCommand: true,
    });
    outbox.start();
    try {
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: '_local_command_state',
          clientMsgId: 'retained-command',
          state: 'uncertain',
        }),
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      outbox.stop();
    }
  },
);

it('does not let an obsolete failed put poison its latest replacement', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const put = f.backend.put;
  let calls = 0;
  f.backend.put = async (id, value) => {
    if (++calls === 1) await gate;
    await put(id, value);
  };
  const store = new LargeChatStorage(f.storage, f.backend);
  store.setItem('draft', 'old'.repeat(100000));
  await vi.waitFor(() => expect(calls).toBe(1));
  const latest = 'latest'.repeat(50000);
  store.setItem('draft', latest);
  reject(Error('Old snapshot quota failure'));
  await store.flush();
  expect(calls).toBe(2);
  expect(store.failed).toBe(false);
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('draft') === latest).toBe(true);
});

it('registers a destination barrier before synchronous cleanup listeners run', async () => {
  const f = fixture();
  let armed = false;
  let entered = false;
  const store = new LargeChatStorage(f.storage, f.backend, () => {
    if (armed && !entered) {
      entered = true;
      store.removeItem('source');
    }
  });
  const source = 'source'.repeat(50000);
  store.setItem('source', source);
  await store.flush();
  f.backend.put = async () => {
    throw Error('Copy failed');
  };
  armed = true;
  store.setItem('destination', source);
  await expect(store.flush()).rejects.toThrow('Copy failed');
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('source') === source).toBe(true);
  expect(cold.getItem('destination')).toBeNull();
});

it('drains a newer value installed by its terminal changed notification', async () => {
  const f = fixture();
  const first = 'first'.repeat(60000),
    last = 'last'.repeat(75000);
  let replaced = false;
  const store = new LargeChatStorage(f.storage, f.backend, () => {
    if (!replaced && !store.pending && store.getItem('draft') === first) {
      replaced = true;
      store.setItem('draft', last);
    }
  });
  store.setItem('draft', first);
  await store.flush();
  expect(store.pending).toBe(false);
  const cold = new LargeChatStorage(f.storage, f.backend);
  await cold.ready();
  expect(cold.getItem('draft') === last).toBe(true);
});

it('refuses a queued foreign-pointer conflict before allocating an obsolete payload', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = f.backend.put;
  let calls = 0;
  f.backend.put = async (id, value) => {
    if (++calls === 1) await gate;
    await put(id, value);
  };
  const store = new LargeChatStorage(f.storage, f.backend);
  store.setItem('blocking', 'block'.repeat(60000));
  await vi.waitFor(() => expect(calls).toBe(1));
  const local = 'pending'.repeat(50000);
  store.setItem('draft', local);
  f.disk.set('draft', 'foreign committed edit');
  release();
  await expect(store.flush()).rejects.toThrow(/another tab/);
  expect(calls).toBe(1);
  expect(f.disk.get('draft')).toBe('foreign committed edit');
  expect(store.getItem('draft') === local).toBe(true);
});
