import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalService, TerminalStore, type TerminalRecord } from '../terminal-service.js';
import { NotificationCenter } from '../notification-center.js';
import { NotificationStore } from '../notification-store.js';
import { registerPending, removePending, resolvePending } from '../permissions.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const target = {
  kind: 'host' as const,
  label: 'Your Mac',
  cwd: '/workspace',
  identity: 'host:idle',
};
const record = (): TerminalRecord => ({
  ...target,
  id: 'terminal-idle',
  owner: 'operator',
  state: 'running',
  createdAt: Date.now(),
});
function terminal() {
  const db = new Database(':memory:');
  const store = new TerminalStore(db);
  const process = { write: vi.fn(), resize: vi.fn(), detach: vi.fn() };
  const backend = { start: vi.fn(async () => process), end: vi.fn(async () => {}) };
  const resolve = vi.fn(async () => target);
  const service = new TerminalService(store, { resolve, backend });
  return { db, store, process, backend, resolve, service };
}
function notifications() {
  const store = new NotificationStore(':memory:');
  const push = vi.fn(async () => ({
    status: 'accepted' as const,
    acceptedDevices: [] as string[],
  }));
  const badge = vi.fn(async () => 'accepted' as const);
  const changed = vi.fn();
  const center = new NotificationCenter(store, {
    push,
    badge,
    changed,
    configured: () => true,
    devices: () => 1,
    sessionTitle: () => 'A chat',
  });
  return { store, center, push, badge, changed };
}

afterEach(() => vi.useRealTimers());

describe('terminal idle owner release', () => {
  it('waits for the existing empty maintenance reconciliation without starting another sweep', async () => {
    const { db, store, service, backend, resolve } = terminal();
    const closeDb = vi.spyOn(db, 'close');
    try {
      const reconcile = vi.spyOn(service, 'reconcileOwners');
      service.startOwnerMaintenance(vi.fn());
      const order: string[] = [];
      void reconcile.mock.results[0].value.then(() => {
        order.push('reconciled');
      });
      const list = vi.spyOn(store, 'list');
      const closing = service.closeIdle().then(() => {
        order.push('released');
      });
      expect(order).toEqual([]);
      expect(() => service.list('operator')).toThrow('released');
      expect(closeDb).not.toHaveBeenCalled();
      await closing;
      expect(order).toEqual(['reconciled', 'released']);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalled();
      expect(backend.start).not.toHaveBeenCalled();
      expect(backend.end).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      await service.closeIdle();
      expect(db.open).toBe(true);
      db.close();
      await service.closeIdle();
      expect(() => service.list('operator')).toThrow('released');
      expect(() => service.get('operator', 'missing')).toThrow('released');
      expect(() =>
        service.bindOwner({ id: 'operator', expiresAt: Date.now() + 60000 }, vi.fn()),
      ).toThrow('released');
      expect(() => service.startOwnerMaintenance(vi.fn())).toThrow('released');
      expect(() => service.reconcileOwners()).toThrow('released');
      await expect(service.open('operator', {})).rejects.toThrow('released');
      await expect(service.subscribe('operator', 'missing', vi.fn())).rejects.toThrow('released');
      await expect(service.write('operator', 'missing', 'pwd\r')).rejects.toThrow('released');
      await expect(
        service.scroll('operator', 'missing', null, {
          signal: new AbortController().signal,
          expiresAt: Date.now() + 60000,
        }),
      ).rejects.toThrow('released');
      await expect(service.resize('operator', 'missing', 80, 24)).rejects.toThrow('released');
      await expect(service.end('operator', 'missing')).rejects.toThrow('released');
    } finally {
      service.detachAll();
      if (db.open) db.close();
    }
  });

  it('refuses an open before its queued resolver runs and remains usable after refusal', async () => {
    const { db, service, resolve, backend } = terminal();
    const pending = deferred<typeof target>();
    resolve.mockImplementation(() => pending.promise);
    const opening = service.open('operator', {});
    try {
      expect(resolve).not.toHaveBeenCalled();
      await expect(service.closeIdle()).rejects.toThrow('active');
      expect(backend.end).not.toHaveBeenCalled();
      pending.resolve(target);
      const opened = await opening;
      expect(opened.state).toBe('running');
      await service.end('operator', opened.id);
      await service.closeIdle();
    } finally {
      pending.resolve(target);
      await opening.catch(() => undefined);
      service.detachAll();
      db.close();
    }
  });

  it.each(['subscribe', 'write', 'scroll', 'resize', 'end'] as const)(
    'refuses a deferred %s even when no running record or live process remains',
    async (method) => {
      const { db, store, service, resolve, backend } = terminal();
      const row = record();
      store.create(row);
      const pending = deferred<typeof target>();
      resolve.mockImplementation(() => pending.promise);
      const authority = { signal: new AbortController().signal, expiresAt: Date.now() + 60000 };
      const operation =
        method === 'subscribe'
          ? service.subscribe('operator', row.id, vi.fn())
          : method === 'write'
            ? service.write('operator', row.id, 'pwd\r')
            : method === 'scroll'
              ? service.scroll('operator', row.id, null, authority)
              : method === 'resize'
                ? service.resize('operator', row.id, 80, 24)
                : service.end('operator', row.id);
      // Model a natural exit while the public operation is awaiting verification.
      store.state(row.id, 'ended');
      const outcome = operation.catch(() => undefined);
      try {
        await expect(service.closeIdle()).rejects.toThrow('active');
        expect(backend.end).not.toHaveBeenCalled();
        pending.resolve(target);
        await outcome;
      } finally {
        pending.resolve(target);
        await outcome;
        service.detachAll();
        db.close();
      }
    },
  );

  it('refuses existing physical reconciliation even if its durable terminal has since ended', async () => {
    const { db, store, service, backend } = terminal();
    const row = record();
    store.create(row);
    store.owners.retire(row.owner);
    const pending = deferred<void>();
    backend.end.mockImplementation(() => pending.promise);
    const reconciling = service.reconcileOwners();
    await Promise.resolve();
    expect(backend.end).toHaveBeenCalledOnce();
    store.state(row.id, 'ended');
    try {
      const closing = service.closeIdle();
      pending.resolve();
      await expect(closing).rejects.toThrow('active');
      expect(backend.end).toHaveBeenCalledOnce();
      pending.resolve();
      await reconciling;
      await service.closeIdle();
      expect(store.list()[0].state).toBe('ended');
    } finally {
      pending.resolve();
      await reconciling;
      service.detachAll();
      db.close();
    }
  });

  it.each(['live', 'durable', 'owner'] as const)(
    'refuses %s custody without cleanup or mutation',
    async (kind) => {
      vi.useFakeTimers();
      const { db, store, service, backend, process } = terminal();
      const release = vi.fn();
      try {
        service.startOwnerMaintenance(() => release);
        await service.reconcileOwners();
        if (kind === 'live') await service.open('operator', {});
        else if (kind === 'durable') store.create(record());
        else service.bindOwner({ id: 'operator', expiresAt: Date.now() + 60000 }, () => release);
        const before = store.list();
        const closeDb = vi.spyOn(db, 'close');
        await expect(service.closeIdle()).rejects.toThrow('active');
        expect(store.list()).toEqual(before);
        expect(backend.end).not.toHaveBeenCalled();
        expect(process.detach).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(closeDb).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        service.detachAll();
        db.close();
      }
    },
  );
});

describe('notification idle owner release', () => {
  it('releases an idle owner idempotently without closing the caller-owned store or delivering', async () => {
    vi.useFakeTimers();
    const { store, center, push, badge } = notifications();
    const closeDb = vi.spyOn(store, 'close');
    try {
      center.start();
      await center.syncBadge();
      push.mockClear();
      badge.mockClear();
      center.closeIdle();
      center.closeIdle();
      expect(vi.getTimerCount()).toBe(0);
      expect(closeDb).not.toHaveBeenCalled();
      store.close();
      center.closeIdle();
      expect(() => center.setInboxReconciler(() => false)).toThrow('released');
      expect(() => center.seatAccessRequest('chat', 'request', 'url', 'Agent')).toThrow('released');
      expect(() => center.resolveSeatAccessRequest('chat', 'request', 'denied')).toThrow(
        'released',
      );
      expect(() => center.turnComplete('chat', 1, 'Done', undefined, true)).toThrow('released');
      expect(() => center.turnFailed('chat', 1, 'Failed', undefined, true)).toThrow('released');
      expect(() => center.update('id', 'Title', 'Body', 'file')).toThrow('released');
      expect(() => center.start()).toThrow('released');
      expect(() => center.changed()).toThrow('released');
      expect(() => center.syncBadge()).toThrow('released');
      expect(() => center.test()).toThrow('released');
      expect(() => center.feed('needs')).toThrow('released');
      await expect(center.flush()).rejects.toThrow('released');
      await vi.runAllTimersAsync();
      expect(push).not.toHaveBeenCalled();
      expect(badge).not.toHaveBeenCalled();
    } finally {
      center.close();
      if (!closeDb.mock.calls.length) store.close();
    }
  });

  it('refuses both queued and deferred badge work without starting another delivery or closing the store', async () => {
    const { store, center, push, badge } = notifications();
    const pending = deferred<'accepted'>();
    badge.mockImplementation(() => pending.promise);
    const closeDb = vi.spyOn(store, 'close');
    const syncing = center.syncBadge();
    try {
      expect(badge).not.toHaveBeenCalled();
      expect(() => center.closeIdle()).toThrow('active');
      await Promise.resolve();
      expect(badge).toHaveBeenCalledTimes(1);
      expect(() => center.closeIdle()).toThrow('active');
      expect(closeDb).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(badge).toHaveBeenCalledTimes(1);
      pending.resolve('accepted');
      await syncing;
      center.closeIdle();
      expect(store.feed('needs').needsYou).toBe(0);
    } finally {
      pending.resolve('accepted');
      await syncing;
      center.close();
      store.close();
    }
  });

  it('refuses an in-flight push and preserves its completion without invoking flush again', async () => {
    const { store, center, push, badge } = notifications();
    const pending = deferred<{ status: 'accepted'; acceptedDevices: string[] }>();
    push.mockImplementation(() => pending.promise);
    const id = center.test();
    await center.syncBadge();
    const flushing = center.flush();
    const closeDb = vi.spyOn(store, 'close');
    try {
      expect(push).toHaveBeenCalledTimes(1);
      const badgeCalls = badge.mock.calls.length;
      expect(() => center.closeIdle()).toThrow('active');
      expect(push).toHaveBeenCalledTimes(1);
      expect(badge).toHaveBeenCalledTimes(badgeCalls);
      expect(closeDb).not.toHaveBeenCalled();
      pending.resolve({ status: 'accepted', acceptedDevices: [] });
      await flushing;
      center.closeIdle();
      expect(store.get(id)).toBeDefined();
    } finally {
      pending.resolve({ status: 'accepted', acceptedDevices: [] });
      await flushing;
      center.close();
      store.close();
    }
  });

  it('refuses a deferred permission refresh without discarding it or unregistering the owner', async () => {
    const { store, center, changed } = notifications();
    const permId = 'idle-release-permission';
    try {
      registerPending(permId, 'Bash', vi.fn(), {}, 'elevated', 'idle-chat', {
        permId,
        toolName: 'Bash',
        toolInput: 'pwd',
        sessionId: 'idle-chat',
      });
      await center.syncBadge();
      changed.mockClear();
      expect(resolvePending(permId, 'deny')).toBe(true);
      expect(() => center.closeIdle()).toThrow('active');
      expect(changed).not.toHaveBeenCalled();
      await new Promise<void>((done) => setImmediate(done));
      expect(changed).toHaveBeenCalledOnce();
      await center.syncBadge();
      center.closeIdle();
      expect(store.get(`permission:${permId}`)?.resolution).toBe('denied');
    } finally {
      removePending(permId);
      center.close();
      store.close();
    }
  });
});
