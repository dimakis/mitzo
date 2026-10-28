import { fixture, physical, cleanups } from './fixtures/prepared-repository-native-consumer.js';
import Database from 'better-sqlite3';
import { FrozenHostCodexBootstrapAuthority } from '../frozen-host-codex-bootstrap.js';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';

it('refuses partial, mismatched and revoked qualified cold owners before effects, and requires fresh physical validation before config', async () => {
  const f = await fixture();
  const result = await f.adopt();
  f.setCwd(result!.directory);
  f.runtime.close();
  const sessionId = f.first.sessionId,
    binding = f.first.lease.binding;
  const primary =
    f.workspace.getForConversation(sessionId)!.preparedRepositoryTransitionAdoption!.childCommandId;
  const eventDb = new Database(join(f.root, 'events.db'));
  const repositoryDb = new Database(join(f.root, 'repositories', 'workspaces.db'));
  const nativeDb = new Database(join(f.root, 'native-transition.db'));
  cleanups.push(
    () => {
      eventDb.close();
    },
    () => {
      repositoryDb.close();
    },
    () => {
      nativeDb.close();
    },
  );
  const savedEvent = (
    eventDb
      .prepare('SELECT ordinary_admission FROM send_commands WHERE client_msg_id=?')
      .get(primary) as { ordinary_admission: string }
  ).ordinary_admission;
  const savedRepository = (
    repositoryDb.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(result!.id) as {
      record: string;
    }
  ).record;
  const make = (name: string) => {
    const request = {
      ...structuredClone(f.request),
      clientMsgId: `refused-cold-${name}`,
      payload: { text: 'Continue only current authorized work' },
    };
    const dispatch = vi.fn(async () => {}),
      launch = vi.fn(() => f.rpc);
    const driver = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      dispatch,
      launch,
    });
    cleanups.push(() => driver.close());
    return { driver, request, dispatch, launch };
  };
  for (const changed of [
    'uncertain',
    'missing-witness',
    'wrong-cwd',
    'running',
    'wrong-account',
  ] as const) {
    if (changed === 'uncertain')
      eventDb
        .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
        .run(JSON.stringify({ ...JSON.parse(savedEvent), state: 'uncertain' }), primary);
    if (changed === 'missing-witness') {
      const row = JSON.parse(savedRepository);
      delete row.preparedRepositoryTransitionAdoption;
      repositoryDb
        .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
        .run(JSON.stringify(row), result!.id);
    }
    if (changed === 'wrong-cwd')
      nativeDb
        .prepare('UPDATE codex_conversations SET cwd=? WHERE id=?')
        .run(f.first.workspace.directory, sessionId);
    if (changed === 'running')
      nativeDb.prepare("UPDATE codex_commands SET status='running' WHERE id=?").run(primary);
    const next = make(changed);
    if (changed === 'wrong-account') next.request.runtime.account.accountId = 'other';
    await expect(next.driver.admitResume(next.request)).rejects.toThrow();
    expect(next.launch).not.toHaveBeenCalled();
    expect(next.dispatch).not.toHaveBeenCalled();
    expect(f.events.getSendCommand(next.request.clientMsgId)).toBeUndefined();
    next.driver.close();
    eventDb
      .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
      .run(savedEvent, primary);
    repositoryDb
      .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
      .run(savedRepository, result!.id);
    nativeDb
      .prepare('UPDATE codex_conversations SET cwd=? WHERE id=?')
      .run(result!.directory, sessionId);
    nativeDb.prepare("UPDATE codex_commands SET status='queued' WHERE id=?").run(primary);
  }
  const failed = make('physical');
  f.rpc.request.mockClear();
  f.rpc.close.mockClear();
  physical.reader.mockRejectedValueOnce(Error('Fresh physical owner unavailable'));
  await expect(failed.driver.admitResume(failed.request)).rejects.toThrow();
  expect(failed.launch).toHaveBeenCalledOnce();
  expect(failed.dispatch).not.toHaveBeenCalled();
  expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('config/read');
  expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('model/list');
  expect(f.rpc.close).toHaveBeenCalled();
  expect(f.events.getOrdinaryLocalCommandAdmission(failed.request.clientMsgId)?.state).toBe(
    'uncertain',
  );
  expect(
    f.native
      .commands(sessionId, binding)
      .some((command) => command.id === failed.request.clientMsgId),
  ).toBe(false);
});

it.each(['native-custody', 'bootstrap-lease'] as const)(
  'rejects original %s owner method replacement during cold reopening before any physical read',
  async (ownerKind) => {
    const f = await fixture(),
      result = await f.adopt();
    f.setCwd(result!.directory);
    f.runtime.close();
    const request = {
      ...structuredClone(f.request),
      clientMsgId: 'cold-replaced-owner',
      payload: { text: 'Continue saved work' },
    };
    const dispatch = vi.fn(async () => {}),
      originalRpc = f.rpc.request.getMockImplementation()!,
      originalRead = f.native.read,
      originalLease = FrozenHostCodexBootstrapAuthority.prototype.currentLease;
    let replaced: ReturnType<typeof vi.spyOn> | undefined;
    f.rpc.request.mockImplementationOnce(async (method) => {
      replaced =
        ownerKind === 'native-custody'
          ? vi.spyOn(f.native, 'read').mockImplementation(function (...args) {
              return originalRead.apply(f.native, args);
            })
          : vi
              .spyOn(FrozenHostCodexBootstrapAuthority.prototype, 'currentLease')
              .mockImplementation(function (this: FrozenHostCodexBootstrapAuthority) {
                return originalLease.call(this);
              });
      return originalRpc(method);
    });
    const before = physical.reader.mock.calls.length,
      originalReader = physical.reader.getMockImplementation()!;
    physical.reader.mockRejectedValueOnce(
      Error('A substituted custody owner must not reach physical read'),
    );
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      launch: () => ({ ...f.rpc, close: vi.fn() }),
      dispatch,
    });
    cleanups.push(() => cold.close());
    try {
      await expect(cold.admitResume(request)).rejects.toThrow();
      expect(replaced).toBeDefined();
      expect(physical.reader.mock.calls.length).toBe(before);
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)?.state).toBe(
        'uncertain',
      );
    } finally {
      replaced?.mockRestore();
      physical.reader.mockReset().mockImplementation(originalReader);
    }
  },
);

it.each(['physical-facet', 'lease-getter'] as const)(
  'enforces genuine async credential revocation despite a poisoned original %s call property',
  async (kind) => {
    const f = await fixture(),
      result = await f.adopt();
    f.setCwd(result!.directory);
    f.runtime.close();
    const prototype = FrozenHostCodexBootstrapAuthority.prototype;
    const originalGetter = prototype.currentLease;
    const previousCall = Object.getOwnPropertyDescriptor(originalGetter, 'call');
    const poisoned = vi.fn(
      async (
        _receiver: unknown,
        signal: AbortSignal,
        action: (owner: unknown) => Promise<void>,
      ) => {
        if (kind === 'lease-getter') return undefined;
        await action({
          signal,
          client: f.rpc,
          binding: f.first.lease.binding,
          assertCurrentSync() {},
          async revalidate() {},
        });
      },
    );
    let getter: ReturnType<typeof vi.spyOn> | undefined;
    if (kind === 'lease-getter') {
      Object.defineProperty(originalGetter, 'call', { value: poisoned, configurable: true });
    } else {
      getter = vi.spyOn(prototype, 'currentLease').mockImplementation(function (
        this: FrozenHostCodexBootstrapAuthority,
      ) {
        const lease = Reflect.apply(originalGetter, this, []);
        if (lease?.withQualifiedWorkspaceReadOwner)
          Object.defineProperty(lease.withQualifiedWorkspaceReadOwner, 'call', {
            value: poisoned,
            configurable: true,
          });
        return lease;
      });
    }
    const originalRpc = f.rpc.request.getMockImplementation()!;
    let reads = 0;
    f.rpc.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'account/read' && ++reads > 1)
        return {
          account: { type: 'chatgpt', email: 'revoked@example.invalid', planType: 'plus' },
        } as never;
      return Reflect.apply(originalRpc, f.rpc, [method, params]);
    });
    const before = physical.reader.mock.calls.length;
    const request = {
      ...structuredClone(f.request),
      clientMsgId: `cold-call-poison-${kind}`,
      payload: { text: 'Continue saved work' },
    };
    const dispatch = vi.fn(async () => {});
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      launch: () => ({ ...f.rpc, close: vi.fn() }),
      dispatch,
    });
    cleanups.push(() => cold.close());
    f.rpc.request.mockClear();
    try {
      await expect(cold.admitResume(request)).rejects.toThrow();
      expect(poisoned).not.toHaveBeenCalled();
      expect(reads).toBeGreaterThan(1);
      expect(physical.reader.mock.calls.length).toBe(before);
      expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('config/read');
      expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('model/list');
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)?.state).toBe(
        'uncertain',
      );
    } finally {
      getter?.mockRestore();
      if (previousCall) Object.defineProperty(originalGetter, 'call', previousCall);
      else Reflect.deleteProperty(originalGetter, 'call');
    }
  },
);
