import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ runtime: undefined as unknown }));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    apiRoutingProfile: () => ({
      credentialRef: { provider: 'keychain', service: 'fixture', account: 'work' },
    }),
    isEnrolledOpenAIAccount: () => false,
  }),
}));
vi.mock('../openai-key-controller.js', () => ({ assertOpenAIKeyController: () => {} }));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => state.runtime }));
import { ConnectionsService } from '../connections-service.js';
import { openAIAccountKeyAuthority } from '../openai-account-key-authority.js';
import { OpenAIKeyManagement } from '../openai-key-management.js';

afterEach(() => {
  state.runtime = undefined;
});
const binding = {
  accountId: 'work',
  accountLabel: 'Work',
  provider: 'openai' as const,
  model: 'offline',
  profileRevision: 'fixture',
};
function fixture() {
  return new ConnectionsService({ list: () => [] } as never, {} as never);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('nested credential gate deadlocked')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

it('qualifies API custody inside an OpenShell runtime reservation without blocking later Mac reads', async () => {
  const service = fixture();
  const ready = vi.fn(async () => {});
  state.runtime = { service, assertOpenAIKeyReady: ready };
  const authority = openAIAccountKeyAuthority(binding);
  await bounded(
    service.withAccountRuntimes('work', async () => {
      await authority.assertReady(new AbortController().signal);
    }),
  );
  await bounded(authority.assertReady(new AbortController().signal));
  expect(ready).toHaveBeenCalledTimes(2);
});

it('keeps unrelated rotation excluded while allowing nested read-only custody checks', async () => {
  const service = fixture(),
    started = deferred(),
    finish = deferred();
  const order: string[] = [];
  const outer = service.withAccountRuntimes('work', async () => {
    await service.withCredentialRead(async () => {
      order.push('read');
    });
    started.resolve();
    await finish.promise;
    order.push('runtime');
  });
  await bounded(started.promise);
  const rotation = service.withCredentialMutation(async () => {
    order.push('rotation');
  });
  await Promise.resolve();
  expect(order).toEqual(['read']);
  finish.resolve();
  await bounded(Promise.all([outer, rotation]));
  expect(order).toEqual(['read', 'runtime', 'rotation']);
});
it('allows Mac custody reads while sandbox allocation is waiting, but fences rotation until both finish', async () => {
  const service = fixture(),
    started = deferred(),
    finish = deferred();
  const runtime = service.withAccountRuntimes('sandbox', async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  try {
    await bounded(service.withCredentialRead(async () => 'mac-key'));
    const mutation = vi.fn(async () => {});
    const rotation = service.withCredentialMutation(mutation);
    await Promise.resolve();
    expect(mutation).not.toHaveBeenCalled();
    finish.resolve();
    await bounded(Promise.all([runtime, rotation]));
    expect(mutation).toHaveBeenCalledOnce();
  } finally {
    finish.resolve();
    await runtime;
  }
});

it('resolves a managed Mac key under an existing reservation without reacquiring mutation authority', async () => {
  const service = fixture();
  const manager = new OpenAIKeyManagement({
    accounts: () => [
      {
        id: 'work',
        label: 'Fixture',
        credentialRef: { provider: 'keychain', service: 'fixture', account: 'work' },
        providerName: 'fixture',
        providerId: 'physical',
      },
    ],
    store: {
      latest: () => undefined,
      completed: () => undefined,
      pending: () => [],
      hasOtherResourceOwner: () => false,
    } as never,
    keychain: { read: async () => ({ value: 'synthetic', version: null }), write: async () => {} },
    gateway: {} as never,
    validateKey: async () => {},
    gatewayBinding: 'fixture',
    workspace: 'fixture',
    gate: (work) => service.withCredentialMutation(work),
    readGate: (work, signal) => service.withCredentialRead(work, signal),
  });
  await expect(
    bounded(
      service.withAccountRuntimes('work', () =>
        manager.resolveHostKey('work', new AbortController().signal),
      ),
    ),
  ).resolves.toBe('synthetic');
});

it('cancels a queued read promptly and never executes its callback after the gate is released', async () => {
  const service = fixture(),
    started = deferred(),
    finish = deferred();
  const outer = service.withCredentialMutation(async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  const controller = new AbortController(),
    read = vi.fn(async () => 'secret');
  const pending = service.withCredentialRead(read, controller.signal);
  controller.abort(Error('cancelled'));
  await expect(bounded(pending)).rejects.toThrow('cancelled');
  finish.resolve();
  await outer;
  await service.withCredentialMutation(async () => {});
  expect(read).not.toHaveBeenCalled();
});

it('refuses recursive mutations explicitly instead of poisoning the queue', async () => {
  const service = fixture();
  await expect(
    bounded(service.withCredentialMutation(() => service.withCredentialMutation(async () => {}))),
  ).rejects.toThrow('mutation cannot reenter');
  await bounded(service.withCredentialMutation(async () => {}));
});

it('does not let an escaped read retain an expired owning reservation', async () => {
  const service = fixture(),
    startRead = deferred(),
    finishRead = deferred();
  let read!: Promise<unknown>;
  await service.withCredentialMutation(async () => {
    read = service.withCredentialRead(async () => {
      startRead.resolve();
      await finishRead.promise;
    });
    await startRead.promise;
  });
  finishRead.resolve();
  await expect(read).rejects.toThrow('reservation expired');
});
