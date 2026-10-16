import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  OpenShellWarmPool,
  type WarmPoolAdapter,
  type WarmSandbox,
} from '../openshell-warm-pool.js';
const roots: string[] = [],
  pools: OpenShellWarmPool[] = [];
afterEach(() => {
  for (const p of pools) p.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  pools.length = roots.length = 0;
});
function fixture(path?: string) {
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-'));
  roots.push(root);
  const physical = new Map<string, WarmSandbox>();
  let next = 0;
  const adapter: WarmPoolAdapter = {
    scope: 'scope-one',
    available: true,
    reason: null,
    prepare: vi.fn(async (record) => {
      const s = {
        name: record.name,
        id: 'physical-' + ++next,
        phase: 'Ready',
        poolId: record.id,
        providers: [],
      };
      physical.set(record.name, s);
      return s;
    }),
    inspect: vi.fn(async (record) => physical.get(record.name)),
    remove: vi.fn(async (record) => {
      physical.delete(record.name);
    }),
    bind: vi.fn(async (record, provider) => {
      const s = physical.get(record.name)!;
      s.providers = [provider];
    }),
  };
  const pool = new OpenShellWarmPool(path ?? join(root, 'pool.db'), adapter);
  pools.push(pool);
  const request = (
    action: string,
    extra: Record<string, unknown> = {},
  ): { action: string; revision: number; requestId: string } & Record<string, unknown> => ({
    action,
    revision: pool.snapshot().revision,
    requestId: crypto.randomUUID(),
    ...extra,
  });
  return { root, pool, adapter, physical, request };
}
it('starts disabled and reads never provision; saves persist across stores', async () => {
  const f = fixture();
  expect(f.pool.snapshot().settings).toMatchObject({
    enabled: false,
    capacity: 1,
    refill: 'auto',
    expiryMinutes: 120,
    cpu: 2,
    memoryGiB: 4,
  });
  expect(f.adapter.prepare).not.toHaveBeenCalled();
  await f.pool.mutate(
    f.request('settings', { settings: { ...f.pool.snapshot().settings, capacity: 2 } }),
  );
  const other = fixture(join(f.root, 'pool.db'));
  expect(other.pool.snapshot().settings.capacity).toBe(2);
  expect(f.adapter.prepare).not.toHaveBeenCalled();
});
it('fills one or two slots and duplicate request never creates again', async () => {
  const f = fixture(),
    r = f.request('settings', {
      settings: { ...f.pool.snapshot().settings, enabled: true, capacity: 2 },
    });
  const saved = await f.pool.mutate(r);
  expect(saved.spares).toHaveLength(2);
  expect(saved.spares.every((x) => x.state === 'ready')).toBe(true);
  await f.pool.mutate(r);
  expect(f.adapter.prepare).toHaveBeenCalledTimes(2);
  await expect(
    f.pool.mutate({ ...r, settings: { ...(r.settings as object), capacity: 1 } }),
  ).rejects.toThrow(/request|reused/i);
});
it('rejects stale saves and unsupported resource controls before side effects', async () => {
  const f = fixture(),
    old = f.request('prepare');
  await f.pool.mutate(
    f.request('settings', { settings: { ...f.pool.snapshot().settings, capacity: 2 } }),
  );
  await expect(f.pool.mutate(old)).rejects.toThrow(/stale/i);
  await expect(
    f.pool.mutate(
      f.request('settings', { settings: { ...f.pool.snapshot().settings, diskGiB: 40 } }),
    ),
  ).rejects.toThrow();
  expect(f.adapter.prepare).not.toHaveBeenCalled();
});
it('claims once before binding and never recycles conversation resources', async () => {
  const f = fixture();
  await f.pool.mutate(
    f.request('settings', { settings: { ...f.pool.snapshot().settings, enabled: true } }),
  );
  let stateAtBind = '';
  vi.mocked(f.adapter.bind).mockImplementation(async (record, provider) => {
    stateAtBind = f.pool.lookup('chat-one', provider)!.state;
    f.physical.get(record.name)!.providers = [provider];
  });
  const claimed = await f.pool.claim('chat-one', 'account-provider', AbortSignal.timeout(5000));
  expect(stateAtBind).toBe('claiming');
  expect(claimed?.state).toBe('claimed');
  expect(f.pool.lookup('chat-one', 'wrong-provider')).toBeNull();
  await f.pool.reconcile();
  expect(f.pool.snapshot().spares).toHaveLength(1);
  expect(f.pool.lookup('chat-one', 'account-provider')?.id).toBe(claimed!.id);
  await expect(f.pool.mutate(f.request('remove', { id: claimed!.id }))).rejects.toThrow(
    /unclaimed|owned/i,
  );
  expect(f.adapter.remove).not.toHaveBeenCalled();
});
it('manual refill leaves a vacancy; paused spares can still be claimed', async () => {
  const f = fixture();
  await f.pool.mutate(
    f.request('settings', {
      settings: { ...f.pool.snapshot().settings, enabled: true, refill: 'manual' },
    }),
  );
  expect(f.pool.snapshot().spares).toHaveLength(0);
  await f.pool.mutate(f.request('prepare'));
  await f.pool.mutate(
    f.request('settings', { settings: { ...f.pool.snapshot().settings, enabled: false } }),
  );
  expect(await f.pool.claim('chat', 'p', AbortSignal.timeout(5000))).not.toBeNull();
  await f.pool.reconcile();
  expect(f.pool.snapshot().spares).toHaveLength(0);
});
it('expiry releases only unused spares and rests without immediate replenishment', async () => {
  const f = fixture();
  let now = 1000;
  f.pool.now = () => now;
  await f.pool.mutate(
    f.request('settings', {
      settings: { ...f.pool.snapshot().settings, enabled: true, capacity: 2, expiryMinutes: 30 },
    }),
  );
  await f.pool.claim('chat', 'p', AbortSignal.timeout(5000));
  now += 31 * 60000;
  await f.pool.reconcile();
  expect(f.pool.snapshot().resting).toBe(true);
  expect(f.pool.snapshot().spares).toHaveLength(0);
  expect(f.pool.lookup('chat', 'p')).not.toBeNull();
  const count = vi.mocked(f.adapter.prepare).mock.calls.length;
  await f.pool.reconcile();
  expect(f.adapter.prepare).toHaveBeenCalledTimes(count);
  await f.pool.mutate(f.request('prepare'));
  expect(f.pool.snapshot().spares).toHaveLength(2);
});
it('uncertain create counts against capacity and is never automatically retried', async () => {
  const f = fixture();
  vi.mocked(f.adapter.prepare).mockRejectedValue(Error('lost create response'));
  await expect(
    f.pool.mutate(
      f.request('settings', { settings: { ...f.pool.snapshot().settings, enabled: true } }),
    ),
  ).rejects.toThrow(/lost create/);
  expect(f.pool.snapshot().spares[0].state).toBe('uncertain');
  await f.pool.reconcile();
  expect(f.adapter.prepare).toHaveBeenCalledTimes(1);
});
it('physical substitution blocks deletion and preserves uncertainty', async () => {
  const f = fixture();
  await f.pool.mutate(f.request('prepare'));
  const record = f.pool.snapshot().spares[0];
  f.physical.get(record.name)!.id = 'replacement';
  await expect(f.pool.mutate(f.request('remove', { id: record.id }))).rejects.toThrow(/identity/i);
  expect(f.adapter.remove).not.toHaveBeenCalled();
  expect(f.pool.snapshot().spares[0].state).toBe('uncertain');
});
it('resource edits retire only unused spares and keep claimed settings', async () => {
  const f = fixture();
  await f.pool.mutate(
    f.request('settings', {
      settings: { ...f.pool.snapshot().settings, enabled: true, capacity: 2 },
    }),
  );
  await f.pool.claim('chat', 'p', AbortSignal.timeout(5000));
  await f.pool.mutate(
    f.request('settings', {
      settings: { ...f.pool.snapshot().settings, capacity: 1, cpu: 4, memoryGiB: 8 },
    }),
  );
  expect(f.pool.snapshot().spares).toHaveLength(1);
  expect(f.pool.snapshot().spares[0].resources).toEqual({ cpu: 4, memoryGiB: 8 });
  expect(f.pool.lookup('chat', 'p')!.resources).toEqual({ cpu: 2, memoryGiB: 4 });
});
it('a durable operation lock prevents a second controller from racing a claim', async () => {
  const f = fixture();
  await f.pool.mutate(f.request('prepare'));
  let release!: () => void;
  vi.mocked(f.adapter.bind).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const claim = f.pool.claim('chat', 'p', AbortSignal.timeout(5000));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const other = fixture(join(f.root, 'pool.db'));
  await expect(other.pool.mutate(other.request('prepare'))).rejects.toThrow(/busy/i);
  release();
  await expect(claim).rejects.toThrow(/provider/i);
});
it('retains an accepted create physical ID when readiness later fails', async () => {
  const f = fixture();
  vi.mocked(f.adapter.prepare).mockImplementation(async (_record, _signal, created) => {
    created?.('accepted-physical-id');
    throw Error('readiness cancelled');
  });
  await expect(f.pool.mutate(f.request('prepare'))).rejects.toThrow(/cancelled/);
  expect(f.pool.snapshot().spares[0]).toMatchObject({
    state: 'uncertain',
    physicalId: 'accepted-physical-id',
  });
});
it('operator recheck releases an uncertain preparation after authoritative absence without retrying it', async () => {
  const f = fixture();
  vi.mocked(f.adapter.prepare).mockRejectedValueOnce(Error('seed publication unavailable'));
  await expect(f.pool.mutate(f.request('prepare'))).rejects.toThrow(/publication/);
  const record = f.pool.snapshot().spares[0];
  expect(record.physicalId).toBeNull();
  await f.pool.mutate(f.request('recheck', { id: record.id }));
  expect(f.pool.snapshot().spares).toHaveLength(0);
  expect(f.adapter.remove).not.toHaveBeenCalled();
  expect(f.adapter.prepare).toHaveBeenCalledTimes(1);
  await f.pool.mutate(f.request('prepare'));
  expect(f.pool.snapshot().spares[0].state).toBe('ready');
});
it('operator recheck adopts a late preparation only after exact neutral origin and Ready observation', async () => {
  const f = fixture();
  vi.mocked(f.adapter.prepare).mockRejectedValueOnce(Error('create response lost'));
  await expect(f.pool.mutate(f.request('prepare'))).rejects.toThrow(/lost/);
  const record = f.pool.snapshot().spares[0];
  const actual = {
    id: 'late-physical',
    name: record.name,
    poolId: record.id,
    phase: 'Ready',
    providers: ['unexpected'],
  };
  f.physical.set(record.name, actual);
  await expect(f.pool.mutate(f.request('recheck', { id: record.id }))).rejects.toThrow(/provider/);
  expect(f.pool.snapshot().spares[0].physicalId).toBeNull();
  actual.providers = [];
  await f.pool.mutate(f.request('recheck', { id: record.id }));
  expect(f.pool.snapshot().spares[0]).toMatchObject({
    physicalId: 'late-physical',
    state: 'ready',
    failure: null,
  });
});
it('absence cannot release a create that was dispatched without a terminal physical receipt', async () => {
  const f = fixture();
  vi.mocked(f.adapter.prepare).mockImplementation(async (_r, _signal, _created, dispatched) => {
    dispatched?.();
    throw Error('lost create response');
  });
  await expect(f.pool.mutate(f.request('prepare'))).rejects.toThrow(/lost/);
  const r = f.pool.snapshot().spares[0];
  await expect(f.pool.mutate(f.request('recheck', { id: r.id }))).rejects.toThrow(
    /unsettled|unknown/,
  );
  expect(f.pool.snapshot().spares).toHaveLength(1);
  expect(f.pool.snapshot().spares[0].state).toBe('uncertain');
  expect(f.adapter.prepare).toHaveBeenCalledTimes(1);
});

it('prepares unique names accepted by the legacy CLI while keeping the full durable origin ID', async () => {
  const f = fixture();
  const prepare = f.adapter.prepare;
  f.adapter.prepare = vi.fn(async (...args: Parameters<WarmPoolAdapter['prepare']>) => {
    const [record] = args;
    expect(record.name).toMatch(/^[a-z][a-z0-9-]{0,18}$/);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    return prepare(...args);
  });
  await f.pool.mutate(
    f.request('settings', {
      settings: { ...f.pool.snapshot().settings, enabled: true, capacity: 2 },
    }),
  );
  const spares = f.pool.snapshot().spares;
  expect(spares.map((r) => r.state)).toEqual(['ready', 'ready']);
  expect(new Set(spares.map((r) => r.name)).size).toBe(2);
  expect(f.adapter.prepare).toHaveBeenCalledTimes(2);
});
