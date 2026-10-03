import type { AccountBinding } from '@mitzo/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';
import {
  migrateRetainedRuntime,
  type RuntimeMigrationAdapters,
} from '../openshell-runtime-migration.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const binding: AccountBinding = {
  accountLabel: 'Offline fixture',
  accountId: 'account',
  provider: 'codex',
  model: 'offline',
  profileRevision: 'v1',
};
function fixture(persistSource = true, owner: 'ordinary' | 'symposium' = 'ordinary') {
  const root = mkdtempSync(join(tmpdir(), 'migration-'));
  roots.push(root);
  const store = new CodexConversationStore(join(root, 'state.db'));
  store.create('chat', binding, root, null, owner);
  store.bindThread('chat', binding, 'same-thread');
  const source = {
    runtime: {
      sandboxName: 'old',
      sandboxId: 'old-id',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: 'openshell',
      workspace: 'default',
      gateway: 'g',
      gatewayInsecure: false,
    },
    route: { kind: 'api' as const, provider: 'bound-provider', model: 'offline' },
  };
  if (persistSource) store.setArtifactRuntime('chat', binding, source);
  const candidate = {
    ...source,
    runtime: { ...source.runtime, sandboxName: 'candidate', sandboxId: 'new-id' },
  };
  const adapters: RuntimeMigrationAdapters = {
    observe: vi.fn(async () => ({ image: 'old-digest', policy: 'policy', resourceVersion: 'r1' })),
    quiescent: vi.fn(async () => {}),
    capture: vi.fn(async () => ({ path: join(root, 'archive'), digest: 'digest' })),
    create: vi.fn(async (name) => {
      candidate.runtime.sandboxName = name;
      return candidate;
    }),
    attest: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    verifyRestored: vi.fn(async (_, identity) => {
      expect(identity.thread).toBe('same-thread');
      expect(identity.image).toBe('old-digest');
    }),
  };
  const input = {
    conversationId: 'chat',
    binding,
    store,
    source,
    targetImage: 'new-digest',
    targetPolicy: 'policy',
    supportedSourceImages: ['old-digest'],
    adapters,
  };
  return { store, source, candidate, adapters, input };
}
it('atomically switches only after attestation, strict origin restore and same-thread verification', async () => {
  const f = fixture();
  f.adapters.verifyRestored = vi.fn(async (_, identity) => {
    expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.source);
    expect(identity.sandboxId).toBe('old-id');
  });
  expect(await migrateRetainedRuntime(f.input)).toEqual(f.candidate);
  expect(f.store.readRuntimeMigration('chat', binding)).toMatchObject({
    phase: 'committed',
    identity: { image: 'old-digest', sandboxId: 'old-id', thread: 'same-thread' },
    targetImage: 'new-digest',
  });
  expect(f.store.read('chat', binding).threadId).toBe('same-thread');
});
it.each(['capture', 'create', 'attest', 'restore', 'verifyRestored'] as const)(
  'retains original mapping and source when %s fails',
  async (step) => {
    const f = fixture();
    f.adapters[step] = vi.fn(async () => {
      throw new Error('injected failure');
    }) as never;
    await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('injected failure');
    expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.source);
    expect(f.store.readRuntimeMigration('chat', binding)?.phase).toBe('blocked');
  },
);
it('rejects unknown image, policy mismatch and changed account profile before capture', async () => {
  const f = fixture();
  await expect(migrateRetainedRuntime({ ...f.input, supportedSourceImages: [] })).rejects.toThrow(
    'supported contract',
  );
  await expect(migrateRetainedRuntime({ ...f.input, targetPolicy: 'other' })).rejects.toThrow(
    'supported contract',
  );
  await expect(
    migrateRetainedRuntime({ ...f.input, binding: { ...binding, profileRevision: 'other' } }),
  ).rejects.toThrow('binding');
  expect(f.adapters.capture).not.toHaveBeenCalled();
});
it('checks thread generation again before atomic switch', async () => {
  const f = fixture();
  f.adapters.verifyRestored = async () => {
    f.store.replaceThread(
      'chat',
      binding,
      'same-thread',
      'other-thread',
      'provider_transport_failure',
    );
  };
  await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('activity changed');
  expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.source);
});
it('rejects active command and source writers without changing active ownership', async () => {
  const f = fixture();
  f.adapters.quiescent = async () => {
    throw new Error('writer active');
  };
  await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('writer active');
  expect(f.adapters.capture).not.toHaveBeenCalled();
  expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.source);
});
it('returns committed candidate after restart without repeating migration', async () => {
  const f = fixture();
  await migrateRetainedRuntime(f.input);
  expect(await migrateRetainedRuntime({ ...f.input, source: f.candidate })).toEqual(f.candidate);
  expect(f.adapters.create).toHaveBeenCalledTimes(1);
});
it.each(['route', 'physical', 'workspace'] as const)(
  'rejects candidate %s drift before restore and switch',
  async (field) => {
    const f = fixture();
    const candidate = structuredClone(f.candidate);
    if (field === 'route') candidate.route.provider = 'other-account';
    if (field === 'physical') candidate.runtime.sandboxId = 'old-id';
    if (field === 'workspace') candidate.runtime.workspace = 'other-workspace';
    f.adapters.create = async (name) => {
      candidate.runtime.sandboxName = name;
      return candidate;
    };
    await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('candidate identity');
    expect(f.adapters.restore).not.toHaveBeenCalled();
    expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.source);
  },
);

it('preserves immutable origin but allows normal thread rollover after committed migration', async () => {
  const f = fixture();
  await migrateRetainedRuntime(f.input);
  f.store.replaceThread(
    'chat',
    binding,
    'same-thread',
    'replacement',
    'provider_transport_failure',
  );
  expect(await migrateRetainedRuntime({ ...f.input, source: f.candidate })).toEqual(f.candidate);
  expect(f.store.readRuntimeMigration('chat', binding)?.identity.thread).toBe('same-thread');
});
it('rejects a competing source ownership mapping before commit', async () => {
  const f = fixture();
  f.adapters.verifyRestored = async () => {
    f.store.setArtifactRuntime('chat', binding, {
      ...f.source,
      runtime: { ...f.source.runtime, sandboxId: 'competing-id' },
    });
  };
  await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('ownership');
});
it('retries cancellation from its durable phase after backoff without another candidate', async () => {
  const f = fixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  f.adapters.verifyRestored = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    .mockResolvedValue(undefined);
  try {
    await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('cancelled');
    expect(f.store.readRuntimeMigration('chat', binding)).toMatchObject({
      phase: 'blocked',
      resumePhase: 'restored',
      retryable: true,
    });
    await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('blocked');
    vi.mocked(Date.now).mockReturnValue(now + 60_001);
    expect(await migrateRetainedRuntime(f.input)).toEqual(f.candidate);
    expect(f.adapters.create).toHaveBeenCalledTimes(1);
    expect(f.adapters.restore).toHaveBeenCalledTimes(1);
    expect(f.adapters.quiescent).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(Date.now).mockRestore();
  }
});
it('fences stale generation writes and immutable origin replacement', async () => {
  const f = fixture();
  await migrateRetainedRuntime(f.input);
  const record = f.store.readRuntimeMigration('chat', binding)!;
  expect(() =>
    f.store.advanceRuntimeMigration('chat', binding, record.generation - 1, { phase: 'observed' }),
  ).toThrow('generation');
  expect(() =>
    f.store.advanceRuntimeMigration('chat', binding, record.generation, {
      identity: { ...record.identity, image: 'new-digest' },
    }),
  ).toThrow();
});

it('accepts volatile ensure metadata but fences the authoritative physical source', async () => {
  const f = fixture();
  f.store.setArtifactRuntime('chat', binding, {
    ...f.source,
    runtime: { ...f.source.runtime, created: true, resourceVersion: 'old' },
  });
  const observed = { ...f.source, runtime: { ...f.source.runtime, resourceVersion: 'new' } };
  expect(await migrateRetainedRuntime({ ...f.input, source: observed })).toEqual(f.candidate);
});
it('does not bypass actual policy validation on an already current image', async () => {
  const f = fixture();
  f.adapters.observe = async () => ({
    image: 'new-digest',
    policy: 'unreviewed',
    resourceVersion: 'r1',
  });
  await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('policy');
});
it('leaves subsequent candidate recreation to the ordinary strict checkpoint lifecycle', async () => {
  const f = fixture();
  await migrateRetainedRuntime(f.input);
  const recreated = {
    ...f.candidate,
    runtime: { ...f.candidate.runtime, sandboxId: 'recreated-id', created: true },
  };
  expect(await migrateRetainedRuntime({ ...f.input, source: recreated })).toEqual(recreated);
  expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.candidate);
  expect(f.store.readRuntimeMigration('chat', binding)?.candidate).toEqual(f.candidate);
});

it('recovers an uncertain candidate create with its precommitted name', async () => {
  const f = fixture();
  const names: string[] = [];
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  f.adapters.create = async (name) => {
    names.push(name);
    f.candidate.runtime.sandboxName = name;
    if (names.length === 1)
      throw Object.assign(new Error('create timed out after provision'), { name: 'TimeoutError' });
    return f.candidate;
  };
  try {
    await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('timed out');
    const persisted = f.store.readRuntimeMigration('chat', binding)!;
    expect(persisted).toMatchObject({ phase: 'blocked', resumePhase: 'checkpointed' });
    vi.mocked(Date.now).mockReturnValue(now + 60_001);
    await migrateRetainedRuntime(f.input);
    expect(names).toEqual([persisted.candidateName, persisted.candidateName]);
    expect(f.adapters.capture).toHaveBeenCalledTimes(1);
  } finally {
    vi.mocked(Date.now).mockRestore();
  }
});
it('fences concurrent attempts so only one can commit candidate ownership', async () => {
  const f = fixture();
  let captured = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.adapters.capture = async () => {
    captured++;
    if (captured === 2) release();
    await gate;
    return { path: '/immutable/archive', digest: 'digest' };
  };
  const outcomes = await Promise.allSettled([
    migrateRetainedRuntime(f.input),
    migrateRetainedRuntime(f.input),
  ]);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  expect(f.store.readRuntimeMigration('chat', binding)?.phase).toBe('committed');
  expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.candidate);
  expect(f.adapters.create).toHaveBeenCalledTimes(1);
});

it('bootstraps a legacy mapping only from an authoritative ordinary provider thread and reviewed observed source', async () => {
  const f = fixture(false);
  await migrateRetainedRuntime(f.input);
  expect(f.store.readRuntimeMigration('chat', binding)).toMatchObject({
    bootstrappedSource: true,
    phase: 'committed',
    identity: { thread: 'same-thread', sandboxId: 'old-id' },
  });
  const other = fixture(false, 'symposium');
  await expect(migrateRetainedRuntime(other.input)).rejects.toThrow('ordinary ownership');
  expect(other.store.readArtifactRuntime('chat', binding)).toBeNull();
  expect(other.adapters.capture).not.toHaveBeenCalled();
});

it('preserves paused queued FIFO while migrating a verified idle source', async () => {
  const f = fixture();
  f.store.enqueue('chat', binding, { id: 'saved', prompt: 'private task' });
  f.store.pauseForRecovery('chat', binding);
  await migrateRetainedRuntime(f.input);
  expect(f.store.lifecycleQueue('chat', binding)).toMatchObject({
    queued: 1,
    running: 0,
    recovery: true,
  });
});

it('admits an actually current policy-verified runtime during ordinary provider fork recovery', async () => {
  const f = fixture();
  f.store.enqueue('chat', binding, { id: 'pending', prompt: 'continue' });
  f.store.pauseForRecovery('chat', binding, undefined, 'interrupted', 'fork');
  f.adapters.observe = vi.fn(async () => ({
    image: 'new-digest',
    policy: 'policy',
    resourceVersion: 'r1',
  }));
  expect(await migrateRetainedRuntime(f.input)).toEqual(f.source);
  expect(f.store.read('chat', binding).recoveryStrategy).toBe('fork');
  expect(f.adapters.observe).toHaveBeenCalledOnce();
  expect(f.adapters.capture).not.toHaveBeenCalled();
  expect(f.store.readRuntimeMigration('chat', binding)).toBeNull();
});
it('still blocks legacy-image fork recovery before checkpoint or candidate creation', async () => {
  const f = fixture();
  f.store.enqueue('chat', binding, { id: 'pending', prompt: 'continue' });
  f.store.pauseForRecovery('chat', binding, undefined, 'interrupted', 'fork');
  await expect(migrateRetainedRuntime(f.input)).rejects.toThrow('resumable provider thread');
  expect(f.adapters.capture).not.toHaveBeenCalled();
  expect(f.adapters.create).not.toHaveBeenCalled();
});
