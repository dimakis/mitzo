import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SymposiumSubscriptionHostOptions } from '../symposium-subscription-host.js';
type FakeAdapter = {
  complete(): void;
  disconnect: ReturnType<typeof vi.fn>;
  beginDeviceLogin: ReturnType<typeof vi.fn>;
  captureDiscovery: ReturnType<typeof vi.fn>;
};
const state = vi.hoisted(() => ({ adapters: new Map<string, FakeAdapter>() }));
vi.mock('../symposium-subscription-host.js', () => ({
  createSymposiumSubscriptionHost: (options: SymposiumSubscriptionHostOptions) => {
    let definition: unknown;
    let finish: (value: unknown) => void;
    let fail: (error: Error) => void;
    const adapter = {
      get activeDefinition() {
        return definition;
      },
      invalidate: vi.fn(() => {
        definition = undefined;
      }),
      disconnect: vi.fn(async () => {
        definition = undefined;
      }),
      captureDiscovery: vi.fn(() => ({
        provider: { name: 'physical-provider', id: 'provider-id' },
        assertCurrent: () => {
          if (!definition) throw new Error('receipt changed');
        },
        publish: vi.fn((models, revision) => {
          definition = { ...(definition as object), models, nativeCatalogRevision: revision };
        }),
      })),
      assertPrivateAuth: vi.fn(),
      verifyPrivateAuth: vi.fn(),
      beginDeviceLogin: vi.fn(async () => ({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
        expiresAt: Date.now() + 60000,
        completed: new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
        cancel: async () => fail(new Error('cancelled')),
      })),
      complete() {
        definition = {
          id: options.accountId,
          label: options.label,
          provider: 'openai-codex',
          nativeAuth: 'sandbox-chatgpt',
          email: 'test@example.test',
          planType: 'plus',
          sandboxProvider: 'provider-' + Math.floor(Math.random() * 1e9),
          sandboxProviderId: 'provider-id',
          sandboxProviderType: 'codex',
          models: options.models,
        };
        finish({ email: 'test@example.test', planType: 'plus' });
      },
    };
    state.adapters.set(options.accountId, adapter);
    return adapter;
  },
}));
import { createPersonalSubscriptionHost } from '../symposium-personal-host.js';
const roots: string[] = [];
afterEach(() => {
  state.adapters.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(discover?: Parameters<typeof createPersonalSubscriptionHost>[2]) {
  const root = mkdtempSync(join(tmpdir(), 'personal-host-'));
  roots.push(root);
  return createPersonalSubscriptionHost(
    {
      gateway: { verifyCustody: vi.fn() } as never,
      seatProof: { verify: vi.fn(), assertCurrent: vi.fn() },
      workProfiles: [],
      accountId: 'default',
      label: 'Default',
      selectedModel: 'luna',
      models: [{ id: 'luna', label: 'Luna' }],
    },
    join(root, 'slots.json'),
    discover,
  );
}
it('connects two independent accounts, rotates only explicit reconnect and fences removed account', async () => {
  const host = fixture();
  const other = host.personalConnections.create('Other');
  for (const row of host.personalConnections.list()) {
    const login = await host.beginDeviceLogin({
      connectionId: row.id,
      expectedRevision: row.revision,
    });
    state.adapters.get(row.id)!.complete();
    await login.completed;
  }
  const before = host.currentProfiles.resolve('default', 'luna');
  const untouched = host.currentProfiles.resolve(other.id, 'luna');
  const row = host.personalConnections.list().find((r) => r.id === 'default')!;
  const reconnect = await host.beginDeviceLogin({
    connectionId: row.id,
    expectedRevision: row.revision,
  });
  expect(() => host.currentProfiles.resolve('default', 'luna')).toThrow();
  expect(host.currentProfiles.resolve(other.id, 'luna')).toEqual(untouched);
  state.adapters.get('default')!.complete();
  await reconnect.completed;
  expect(host.currentProfiles.resolve('default', 'luna').profileRevision).not.toBe(
    before.profileRevision,
  );
  expect(state.adapters.get('default')!.disconnect).toHaveBeenCalledOnce();
  expect(state.adapters.get(other.id)!.disconnect).not.toHaveBeenCalled();
  await expect(
    host.beginDeviceLogin({ connectionId: row.id, expectedRevision: row.revision }),
  ).rejects.toThrow('changed');
});
it('quarantines cleanup failure and does not allocate a replacement login', async () => {
  const host = fixture();
  const row = host.personalConnections.list()[0];
  const login = await host.beginDeviceLogin({
    connectionId: row.id,
    expectedRevision: row.revision,
  });
  state.adapters.get(row.id)!.complete();
  await login.completed;
  state.adapters.get(row.id)!.disconnect.mockRejectedValue(new Error('attached credentials'));
  const connected = host.personalConnections.list()[0];
  await expect(
    host.beginDeviceLogin({ connectionId: row.id, expectedRevision: connected.revision }),
  ).rejects.toThrow('cleanup');
  expect(host.personalConnections.list()[0].state).toBe('recovery_required');
  expect(host.currentProfiles.catalog()).toEqual([]);
  expect(state.adapters.get(row.id)!.beginDeviceLogin).toHaveBeenCalledOnce();
});

it('cancelling a just-completed login removes its admitted provider instead of leaving a connected row', async () => {
  const host = fixture();
  const row = host.personalConnections.list()[0];
  const login = await host.beginDeviceLogin({
    connectionId: row.id,
    expectedRevision: row.revision,
  });
  state.adapters.get(row.id)!.complete();
  await login.completed;
  await login.cancel();
  expect(host.personalConnections.list()[0].state).toBe('disconnected');
  expect(host.currentProfiles.catalog()).toEqual([]);
});

it('cannot implicitly reconnect the default slot through direct host entrypoints', async () => {
  const host = fixture();
  const row = host.personalConnections.list()[0];
  const login = await host.beginDeviceLogin({
    connectionId: row.id,
    expectedRevision: row.revision,
  });
  state.adapters.get(row.id)!.complete();
  await login.completed;
  await expect(host.beginDeviceLogin()).rejects.toThrow('explicit');
  await expect(host.beginLogin()).rejects.toThrow('explicit');
  expect(state.adapters.get(row.id)!.disconnect).not.toHaveBeenCalled();
  expect(host.personalConnections.list()[0].state).toBe('connected');
});

async function connected(host: ReturnType<typeof fixture>) {
  const row = host.personalConnections.list()[0];
  const login = await host.beginDeviceLogin({
    connectionId: row.id,
    expectedRevision: row.revision,
  });
  state.adapters.get(row.id)!.complete();
  await login.completed;
  return host.personalConnections.list()[0];
}
it('serializes discovery with login/disconnect and publishes a new explicit selection revision', async () => {
  let release!: (value: Awaited<ReturnType<NonNullable<Parameters<typeof fixture>[0]>>>) => void;
  const discover = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<NonNullable<Parameters<typeof fixture>[0]>>>>((resolve) => {
        release = resolve;
      }),
  );
  const host = fixture(discover);
  const row = await connected(host);
  const before = host.currentProfiles.resolve(row.id, 'luna');
  const pending = host.personalConnections.discoverModels(row.id, row.revision, () => {});
  const latest = host.personalConnections.list()[0];
  expect(() => host.personalConnections.create('Blocked')).toThrow('discovery');
  expect(() =>
    host.captureAdmissionProvider({ connectionId: row.id, expectedRevision: latest.revision }),
  ).toThrow('discovery');
  await expect(
    host.beginDeviceLogin({ connectionId: row.id, expectedRevision: latest.revision }),
  ).rejects.toThrow('discovery');
  await expect(host.personalConnections.disconnect(row.id, latest.revision)).rejects.toThrow(
    'discovery',
  );
  release({
    result: { status: 'complete', inference: false, modelCount: 1, lunaModels: ['luna'] },
    models: [{ id: 'luna', label: 'Luna' }],
  });
  expect((await pending).status).toBe('complete');
  expect(host.currentProfiles.resolve(row.id, 'luna').profileRevision).not.toBe(
    before.profileRevision,
  );
  expect(host.personalConnections.list()[0].modelDiscovery).toBeUndefined();
  await expect(
    host.personalConnections.discoverModels(row.id, row.revision, () => {}),
  ).rejects.toThrow('changed');
});
it('retains recovery and excludes account when cleanup or receipt proof fails', async () => {
  const host = fixture(async () => ({
    result: { status: 'reconciliation_required', inference: false },
  }));
  const row = await connected(host);
  expect(
    (await host.personalConnections.discoverModels(row.id, row.revision, () => {})).status,
  ).toBe('reconciliation_required');
  expect(host.personalConnections.list()[0]).toMatchObject({
    state: 'recovery_required',
    modelDiscovery: 'reconciliation_required',
  });
  expect(host.currentProfiles.catalog()).toEqual([]);
  expect(() => host.personalConnections.create('Blocked')).toThrow('discovery');
});

it('does not publish discovery after the initiating operator session is revoked', async () => {
  let current = true;
  const host = fixture(async (proof) => {
    current = false;
    expect(() => proof.assertCurrent()).toThrow('revoked');
    return {
      result: { status: 'complete', inference: false, modelCount: 1, lunaModels: ['luna'] },
      models: [{ id: 'luna', label: 'Luna' }],
    };
  });
  const row = await connected(host);
  await expect(
    host.personalConnections.discoverModels(row.id, row.revision, () => {
      if (!current) throw new Error('revoked');
    }),
  ).rejects.toThrow('recovery');
  expect(host.currentProfiles.catalog()).toEqual([]);
  expect(host.personalConnections.list()[0].state).toBe('recovery_required');
});
it('captures only a connected exact slot revision and fences disconnect or replacement', async () => {
  const host = fixture();
  const row = await connected(host);
  const proof = host.captureAdmissionProvider({
    connectionId: row.id,
    expectedRevision: row.revision,
  });
  expect(proof.provider).toEqual({
    name: 'physical-provider',
    id: 'provider-id',
    type: 'codex',
    profileName: 'codex',
  });
  expect(JSON.stringify(proof)).not.toContain('email');
  expect(() =>
    host.captureAdmissionProvider({ connectionId: row.id, expectedRevision: row.revision - 1 }),
  ).toThrow();
  const other = host.personalConnections.create('Other');
  expect(() =>
    host.captureAdmissionProvider({ connectionId: other.id, expectedRevision: other.revision }),
  ).toThrow();
  await host.personalConnections.disconnect(row.id, row.revision);
  expect(() => proof.assertCurrent()).toThrow();
});

it.each(['capture', 'operator'])(
  'releases the local discovery marker when %s preflight rejects before calling discovery',
  async (failure) => {
    const discover = vi.fn();
    const host = fixture(discover);
    const row = await connected(host);
    if (failure === 'capture')
      state.adapters.get(row.id)!.captureDiscovery.mockImplementationOnce(() => {
        throw new Error('receipt unavailable');
      });
    let checks = 0;
    await expect(
      host.personalConnections.discoverModels(row.id, row.revision, () => {
        if (++checks === 2 && failure === 'operator') throw new Error('revoked');
      }),
    ).rejects.toThrow();
    expect(discover).not.toHaveBeenCalled();
    const latest = host.personalConnections.list()[0];
    expect(latest.state).toBe('connected');
    expect(latest.modelDiscovery).toBeUndefined();
    await expect(
      host.personalConnections.disconnect(row.id, latest.revision),
    ).resolves.toMatchObject({ state: 'disconnected' });
  },
);

it('retains recovery if the discovery capability throws after it was entered', async () => {
  const host = fixture(async () => {
    throw new Error('unknown allocation');
  });
  const row = await connected(host);
  await expect(
    host.personalConnections.discoverModels(row.id, row.revision, () => {}),
  ).rejects.toThrow('recovery');
  expect(host.personalConnections.list()[0]).toMatchObject({
    state: 'recovery_required',
    modelDiscovery: 'reconciliation_required',
  });
});

it('recovers only a retained revision-bound capability and requires explicit fresh login', async () => {
  const recover = vi.fn(async (check: () => void) => {
    check();
    return { status: 'reconciled' as const, inference: false as const };
  });
  const host = fixture(async () => ({
    result: { status: 'reconciliation_required', inference: false },
    recover,
  }));
  const row = await connected(host);
  await host.personalConnections.discoverModels(row.id, row.revision, () => {});
  const quarantined = host.personalConnections.list()[0];
  await expect(
    host.personalConnections.recoverDiscovery(row.id, row.revision, () => {}),
  ).rejects.toThrow();
  expect(recover).not.toHaveBeenCalled();
  await host.personalConnections.recoverDiscovery(row.id, quarantined.revision, () => {});
  expect(host.personalConnections.list()[0]).toMatchObject({ state: 'reauth_required' });
  expect(host.personalConnections.list()[0].modelDiscovery).toBeUndefined();
  expect(host.currentProfiles.catalog()).toEqual([]);
});
it('preserves quarantine without retained cleanup proof', async () => {
  const host = fixture(async () => ({
    result: { status: 'reconciliation_required', inference: false },
  }));
  const row = await connected(host);
  await host.personalConnections.discoverModels(row.id, row.revision, () => {});
  const quarantined = host.personalConnections.list()[0];
  await expect(
    host.personalConnections.recoverDiscovery(row.id, quarantined.revision, () => {}),
  ).rejects.toThrow();
  expect(host.personalConnections.list()[0]).toEqual(quarantined);
});
it('serializes recovery and preserves quarantine after operator revocation', async () => {
  let release!: () => void;
  const recover = vi.fn(async (check: () => void) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    check();
    return { status: 'reconciled' as const, inference: false as const };
  });
  const host = fixture(async () => ({
    result: { status: 'reconciliation_required', inference: false },
    recover,
  }));
  const row = await connected(host);
  await host.personalConnections.discoverModels(row.id, row.revision, () => {});
  const quarantined = host.personalConnections.list()[0];
  let revoked = false;
  const pending = host.personalConnections.recoverDiscovery(row.id, quarantined.revision, () => {
    if (revoked) throw new Error('Revoked');
  });
  await expect(
    host.personalConnections.recoverDiscovery(row.id, quarantined.revision, () => {}),
  ).rejects.toThrow('already running');
  revoked = true;
  release();
  await expect(pending).rejects.toThrow('Revoked');
  expect(host.personalConnections.list()[0]).toEqual(quarantined);
});
