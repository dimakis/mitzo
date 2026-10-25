import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialConnectionStore } from '../credential-connections.js';
import { SecretRelays } from '../secret-relay.js';
const stores: CredentialConnectionStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const signal = () => AbortSignal.timeout(1000);
function fixture() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const ref = {
    gateway: 'gateway',
    workspace: 'workspace',
    name: 'mitzo-secret-11111111-1111-4111-8111-111111111111',
    providerId: 'id',
    version: '1',
    profileVersion: '1',
  };
  const vault = { save: vi.fn(async () => ref), read: vi.fn(async () => 'private-fixture') };
  let revision = 1;
  const connection = vi.fn(() => ({
    id: 'api',
    revision,
    label: 'Fixture API',
    endpoint: 'https://example.com',
    paths: ['/api/'],
    methods: ['POST'],
    status: 'active',
  }));
  const apply = vi.fn(async (_session, _target, _body, _encoding, _signal, check, dispatched) => {
    check();
    dispatched();
    return { status: 200 };
  });
  const service = new SecretRelays(store, vault, connection, apply);
  const input = {
    label: 'MQTT password',
    targets: [
      {
        connectionId: 'api',
        revision: 1,
        path: '/api/set',
        method: 'POST',
        encoding: 'json',
        body: '{"user":"mqtt","password":null}',
        fields: ['/password'],
      },
      {
        connectionId: 'api',
        revision: 1,
        path: '/api/device',
        method: 'POST',
        encoding: 'form',
        body: 'user=mqtt&password=',
        fields: ['password'],
      },
    ],
  };
  return { service, store, vault, apply, input, change: () => revision++ };
}
describe('private secret relay', () => {
  it('captures once, keeps values out of metadata, and injects into two exact approved writes', async () => {
    const { service, store, vault, apply, input } = fixture();
    const draft = service.prepare('chat', input);
    expect(service.prepare('chat', input).id).toBe(draft.id);
    const ready = await service.complete(
      draft.id,
      draft.revision,
      'private-fixture',
      signal(),
      () => true,
    );
    expect(ready.status).toBe('ready');
    expect(JSON.stringify(store.listRelays())).not.toContain('private-fixture');
    expect(JSON.stringify(ready)).not.toContain('providerId');
    expect(await service.apply('chat', draft.id, 0, signal(), () => true)).toEqual({
      outcome: 'confirmed',
      status: 200,
    });
    expect(apply.mock.calls[0][2]).toBe('{"user":"mqtt","password":"private-fixture"}');
    expect(await service.apply('chat', draft.id, 1, signal(), () => true)).toEqual({
      outcome: 'confirmed',
      status: 200,
    });
    expect(apply.mock.calls[1][2]).toBe('user=mqtt&password=private-fixture');
    await service.apply('chat', draft.id, 0, signal(), () => true);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(vault.save).toHaveBeenCalledTimes(1);
  });
  it('rejects other sessions, destination rotation and scope changes before secret resolution', async () => {
    const { service, input, vault, change } = fixture();
    const draft = service.prepare('chat', input);
    await service.complete(draft.id, 1, 'private-fixture', signal(), () => true);
    await expect(service.apply('other', draft.id, 0, signal(), () => true)).rejects.toThrow();
    change();
    await expect(service.apply('chat', draft.id, 0, signal(), () => true)).rejects.toThrow();
    expect(vault.read).not.toHaveBeenCalled();
  });
  it('records an uncertain dispatched write durably and never replays it', async () => {
    const { service, input, apply, vault } = fixture();
    const draft = service.prepare('chat', input);
    await service.complete(draft.id, 1, 'private-fixture', signal(), () => true);
    apply.mockImplementationOnce(async (_s, _t, _b, _e, _sig, _check, dispatched) => {
      dispatched();
      throw new Error('private-fixture');
    });
    expect(await service.apply('chat', draft.id, 0, signal(), () => true)).toEqual({
      outcome: 'unconfirmed',
    });
    expect(await service.apply('chat', draft.id, 0, signal(), () => true)).toEqual({
      outcome: 'unconfirmed',
    });
    expect(vault.read).toHaveBeenCalledTimes(1);
  });
  it('rejects dynamic or missing placeholders and traversal before capture', () => {
    const { service, input, vault } = fixture();
    for (const body of ['{"password":"agent-value"}', '{}'])
      expect(() =>
        service.prepare('chat', { ...input, targets: [{ ...input.targets[0], body }] }),
      ).toThrow();
    expect(() =>
      service.prepare('chat', {
        ...input,
        targets: [{ ...input.targets[0], path: '/api/../elsewhere' }],
      }),
    ).toThrow();
    expect(vault.save).not.toHaveBeenCalled();
  });
  it('revokes ready secrets and rechecks authority after asynchronous resolution', async () => {
    const { service, input, vault, apply } = fixture();
    const draft = service.prepare('chat', input);
    const ready = await service.complete(draft.id, 1, 'private-fixture', signal(), () => true);
    vault.read.mockImplementationOnce(async () => {
      service.cancel(draft.id, ready.revision);
      return 'private-fixture';
    });
    await expect(service.apply('chat', draft.id, 0, signal(), () => true)).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
  });
});

it('redacts later reads of the destination using persisted references', async () => {
  const { service, input } = fixture();
  const draft = service.prepare('chat', input);
  await service.complete(draft.id, 1, 'private-fixture', signal(), () => true);
  const result = await service.redactResponse(
    'chat',
    'api',
    '{"password":"private-fixture","ok":true}',
    signal(),
  );
  expect(result).not.toContain('private-fixture');
  expect(JSON.parse(result).ok).toBe(true);
});

it('allows exact local device form writes only with the separate LAN adapter enabled', async () => {
  const f = fixture();
  const input = {
    label: 'MQTT',
    targets: [
      {
        lanEndpoint: 'http://192.168.1.115',
        path: '/settings',
        method: 'POST',
        encoding: 'form',
        body: 'mqtt_password=',
        fields: ['mqtt_password'],
      },
    ],
  };
  expect(() => f.service.prepare('chat', input)).toThrow();
  const enabled = new SecretRelays(
    f.store,
    f.vault,
    () => {
      throw new Error('No API auth needed');
    },
    f.apply,
    true,
  );
  const draft = enabled.prepare('chat', input);
  expect(draft.targets[0].endpoint).toBe('http://192.168.1.115');
});

it('caps in-flight secret writes to relay expiry independently of the outer timeout', async () => {
  const f = fixture();
  const draft = f.service.prepare('chat', f.input);
  await f.service.complete(draft.id, 1, 'private-fixture', signal(), () => true);
  f.store.putRelay({ ...f.store.getRelay(draft.id)!, expiresAt: Date.now() + 50 });
  const outer = AbortSignal.timeout(500);
  let outerAborted: boolean | undefined;
  f.apply.mockImplementationOnce(
    async (_session, _target, _body, _encoding, activeSignal, _check, dispatched) => {
      dispatched();
      await new Promise<void>((_resolve, reject) =>
        activeSignal.addEventListener(
          'abort',
          () => {
            outerAborted = outer.aborted;
            reject(new Error('Cancelled'));
          },
          { once: true },
        ),
      );
      return { status: 200 };
    },
  );
  expect(await f.service.apply('chat', draft.id, 0, outer, () => true)).toEqual({
    outcome: 'unconfirmed',
  });
  expect(outerAborted).toBe(false);
});

it('reviews native MQTT targets only when enabled, resolves privately and persists the acknowledgement', async () => {
  const f = fixture();
  const input = {
    label: 'Broker password',
    targets: [
      {
        adapter: 'mqtt',
        broker: 'mqtts://broker.example:8883',
        username: 'device',
        operation: 'connect',
      },
    ],
  };
  expect(() => f.service.prepare('chat', input)).toThrow();
  const send = vi.fn(async (_s, _t, secret, _e, _sig, check, dispatched) => {
    expect(secret).toBe('private-fixture');
    check();
    dispatched();
    return { acknowledgement: 'connack' as const };
  });
  const service = new SecretRelays(
    f.store,
    f.vault,
    () => {
      throw new Error('HTTP connection not needed');
    },
    send,
    false,
    { mqtt: true },
  );
  const draft = service.prepare('chat', input);
  await service.complete(draft.id, 1, 'private-fixture', signal(), () => true);
  expect(await service.apply('chat', draft.id, 0, signal(), () => true)).toEqual({
    outcome: 'confirmed',
    acknowledgement: 'connack',
  });
  await service.apply('chat', draft.id, 0, signal(), () => true);
  expect(send).toHaveBeenCalledOnce();
});
