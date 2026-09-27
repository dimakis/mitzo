import { expect, it, vi } from 'vitest';
import {
  runSymposiumModelDiscovery,
  DiscoveryNotDispatchedError,
  type DiscoveryOperations,
  type DiscoveryReceipt,
} from '../symposium-model-discovery.js';
function fixture() {
  let receipt: DiscoveryReceipt | undefined;
  let exists = false;
  const events: string[] = [];
  const config = {
    cliSha256: 'a'.repeat(64),
    workloadImage: `sha256:${'b'.repeat(64)}`,
    policySha256: 'c'.repeat(64),
    podmanUrl: 'unix:///private/mock-podman.sock',
    gateway: 'owned',
    workspace: 'work',
    provider: { name: 'personal', id: 'provider-1' },
  };
  const operations: DiscoveryOperations = {
    withExclusiveAttempt: async (operation) => operation(),
    verifyCustody: vi.fn(async () => {}),
    readReceipt: async () => receipt,
    persistReceipt: async (value, exclusive) => {
      if (exclusive && receipt) throw new Error('exists');
      receipt = value;
      events.push('persist');
    },
    clearReceipt: async () => {
      receipt = undefined;
    },
    list: async () =>
      exists
        ? [
            {
              id: 'sandbox-1',
              name: receipt!.name,
              workspace: 'work',
              phase: 'Ready',
              labels: {
                'mitzo.discovery': 'models',
                'mitzo.discovery.claim': receipt!.claim,
              },
            },
          ]
        : [],
    create: vi.fn(async () => {
      events.push('create');
      exists = true;
    }),
    attachedProviders: async () => [{ name: 'personal', type: 'codex' }],
    providerInventory: async () => [
      { name: 'personal', id: 'provider-1', type: 'codex', workspace: 'work' },
    ],
    openClient: async () => ({
      initialize: async () => {},
      request: vi.fn(async (method) => {
        events.push(method);
        return method === 'account/read'
          ? { account: { type: 'chatgpt', email: 'secret@example.test' } }
          : { data: [{ model: 'gpt-5.6-luna', displayName: 'Luna' }], nextCursor: null };
      }),
      close: () => {},
    }),
    cancel: async () => {},
    delete: async () => {
      exists = false;
    },
    physicalAbsent: vi.fn(async () => true),
    wait: async () => {},
  };
  return { config, operations, events, receipt: () => receipt };
}
it('persists a bounded name before create and calls only read RPCs, then verifies both cleanup planes', async () => {
  const f = fixture();
  const result = await runSymposiumModelDiscovery(f.config, f.operations);
  expect(f.events.slice(0, 2)).toEqual(['persist', 'create']);
  expect(f.events.filter((event) => event.includes('/'))).toEqual(['account/read', 'model/list']);
  expect(result).toEqual({
    status: 'complete',
    inference: false,
    modelCount: 1,
    lunaModels: ['gpt-5.6-luna'],
  });
  expect(f.receipt()).toBeUndefined();
  expect(f.operations.physicalAbsent).toHaveBeenCalled();
});
it('reconciles a failed create that actually allocated a sandbox', async () => {
  const f = fixture();
  const create = f.operations.create;
  f.operations.create = async (...args) => {
    await create(...args);
    throw new Error('secret token');
  };
  expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
    status: 'failed',
    inference: false,
  });
  expect(f.receipt()).toBeUndefined();
});
it('retains intent for ambiguous creation even if no resources have appeared yet', async () => {
  const f = fixture();
  f.operations.create = async () => {
    throw new Error('secret token');
  };
  expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
    status: 'reconciliation_required',
    inference: false,
  });
  expect(f.receipt()!.name.length).toBeLessThanOrEqual(19);
});
it('does not claim cleanup complete until physical deletion is observed', async () => {
  const f = fixture();
  f.operations.physicalAbsent = vi.fn(async () => false);
  expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
    status: 'reconciliation_required',
    inference: false,
  });
  expect(f.receipt()).toBeTruthy();
});
it('rejects a different provider before opening a read client and sanitizes errors', async () => {
  const f = fixture();
  f.operations.providerInventory = async () => [
    { id: 'other', name: 'personal', type: 'codex', workspace: 'work' },
  ];
  f.operations.openClient = vi.fn();
  expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
    status: 'failed',
    inference: false,
  });
  expect(f.operations.openClient).not.toHaveBeenCalled();
});

it('polls an asynchronous gateway deletion and later physical disappearance', async () => {
  const f = fixture();
  const remove = f.operations.delete;
  let deletes = 0;
  f.operations.delete = async (...args) => {
    if (++deletes === 2) await remove(...args);
  };
  f.operations.physicalAbsent = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe('complete');
  expect(deletes).toBe(2);
  expect(f.operations.physicalAbsent).toHaveBeenCalledTimes(2);
});
it('reconciles a retained receipt without opening another client or creating again', async () => {
  const f = fixture();
  f.operations.physicalAbsent = async () => false;
  expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe(
    'reconciliation_required',
  );
  f.operations.physicalAbsent = async () => true;
  f.operations.create = vi.fn();
  f.operations.openClient = vi.fn();
  expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe('reconciled');
  expect(f.operations.create).not.toHaveBeenCalled();
  expect(f.operations.openClient).not.toHaveBeenCalled();
});
it('does not delete a replacement with a different claim and retains reconciliation', async () => {
  const f = fixture();
  const list = f.operations.list;
  f.operations.list = async () =>
    ((await list()) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      labels: { 'mitzo.discovery.claim': 'other' },
    }));
  f.operations.delete = vi.fn();
  expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe(
    'reconciliation_required',
  );
  expect(f.operations.delete).not.toHaveBeenCalled();
});

it.each(['other-workspace', 'duplicate', 'wrong-type'])(
  'rejects global provider identity %s before launching',
  async (kind) => {
    const f = fixture();
    const row = {
      name: 'personal',
      id: 'provider-1',
      type: kind === 'wrong-type' ? 'openai' : 'codex',
      workspace: kind === 'other-workspace' ? 'other' : 'work',
    };
    f.operations.providerInventory = async () => (kind === 'duplicate' ? [row, row] : [row]);
    f.operations.openClient = vi.fn();
    expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe('failed');
    expect(f.operations.openClient).not.toHaveBeenCalled();
  },
);

it('publishes a catalog only after both cleanup planes and journal completion', async () => {
  const f = fixture();
  const publish = vi.fn(() => {
    expect(f.receipt()).toBeUndefined();
    expect(f.operations.physicalAbsent).toHaveBeenCalled();
  });
  expect((await runSymposiumModelDiscovery(f.config, f.operations, publish)).status).toBe(
    'complete',
  );
  expect(publish).toHaveBeenCalledWith([expect.objectContaining({ id: 'gpt-5.6-luna' })]);
  const blocked = fixture();
  blocked.operations.physicalAbsent = async () => false;
  const forbidden = vi.fn();
  await runSymposiumModelDiscovery(blocked.config, blocked.operations, forbidden);
  expect(forbidden).not.toHaveBeenCalled();
});

it('does not inspect or reconcile a journal held by another active attempt', async () => {
  const f = fixture();
  f.operations.withExclusiveAttempt = async () => {
    throw new Error('busy');
  };
  f.operations.readReceipt = vi.fn();
  f.operations.cancel = vi.fn();
  f.operations.clearReceipt = vi.fn();
  expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe(
    'reconciliation_required',
  );
  expect(f.operations.readReceipt).not.toHaveBeenCalled();
  expect(f.operations.cancel).not.toHaveBeenCalled();
  expect(f.operations.clearReceipt).not.toHaveBeenCalled();
});

it('accepts owned-host dotted identifiers and repository-pinned workload images', async () => {
  const f = fixture();
  f.config.gateway = 'owned.gateway';
  f.config.workloadImage = `registry.example.test/team/runtime@sha256:${'b'.repeat(64)}`;
  expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe('complete');
});

it('clears only a proven undispatched attempt without claiming inventory cleanup', async () => {
  const f = fixture();
  f.operations.create = async () => {
    throw new DiscoveryNotDispatchedError('preflight');
  };
  expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
    status: 'failed',
    inference: false,
  });
  expect(f.receipt()).toBeUndefined();
  expect(f.operations.physicalAbsent).not.toHaveBeenCalled();
});
it('retains reconciliation when an undispatched journal cannot be cleared', async () => {
  const f = fixture();
  f.operations.create = async () => {
    throw new DiscoveryNotDispatchedError('preflight');
  };
  f.operations.clearReceipt = async () => {
    throw new Error('disk');
  };
  expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
    status: 'reconciliation_required',
    inference: false,
  });
  expect(f.receipt()).toBeDefined();
});

it('bounds distinct model cursors and still completes both cleanup planes', async () => {
  const f = fixture();
  const close = vi.fn();
  let pages = 0;
  f.operations.openClient = async () => ({
    initialize: async () => {},
    close,
    request: async (method) =>
      method === 'account/read'
        ? { account: { type: 'chatgpt' } }
        : { data: [{ model: 'gpt-5.6-luna', displayName: 'Luna' }], nextCursor: `page-${++pages}` },
  });
  expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
    status: 'failed',
    inference: false,
  });
  expect(pages).toBe(100);
  expect(close).toHaveBeenCalledOnce();
  expect(f.receipt()).toBeUndefined();
});

it('times out the full model read and closes the client before cleanup', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const close = vi.fn();
    f.operations.openClient = async () => ({
      initialize: async () => {},
      close,
      request: async (method) =>
        method === 'account/read' ? { account: { type: 'chatgpt' } } : new Promise(() => {}),
    });
    const result = runSymposiumModelDiscovery(f.config, f.operations);
    await vi.advanceTimersByTimeAsync(60001);
    expect(await result).toEqual({ status: 'failed', inference: false });
    expect(close).toHaveBeenCalledOnce();
    expect(f.receipt()).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it.each([false, true])(
  'handles custody rejection before create with journal cleanup failure=%s',
  async (cleanupFails) => {
    const f = fixture();
    vi.mocked(f.operations.verifyCustody)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('custody changed'));
    if (cleanupFails)
      f.operations.clearReceipt = async () => {
        throw new Error('disk');
      };
    expect(await runSymposiumModelDiscovery(f.config, f.operations)).toEqual({
      status: cleanupFails ? 'reconciliation_required' : 'failed',
      inference: false,
    });
    expect(f.operations.create).not.toHaveBeenCalled();
    expect(!!f.receipt()).toBe(cleanupFails);
    expect(f.operations.physicalAbsent).not.toHaveBeenCalled();
    if (!cleanupFails) {
      vi.mocked(f.operations.verifyCustody).mockResolvedValue(undefined);
      expect((await runSymposiumModelDiscovery(f.config, f.operations)).status).toBe('complete');
    }
  },
);
