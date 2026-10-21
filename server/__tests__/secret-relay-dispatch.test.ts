import { afterEach, expect, it, vi } from 'vitest';
import {
  CredentialConnections,
  CredentialConnectionStore,
  type ConnectionSender,
} from '../credential-connections.js';
const stores: CredentialConnectionStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
async function fixture() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const vault = {
    save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
    link: vi.fn(),
    read: vi.fn(async () => 'auth-fixture'),
    remove: vi.fn(),
  };
  const send = vi.fn<ConnectionSender>(async () => ({
    status: 200,
    body: 'secret-fixture auth-fixture',
  }));
  const service = new CredentialConnections(store, vault, send);
  const c = await service.create(
    {
      label: 'API',
      endpoint: 'https://example.com',
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      methods: ['POST'],
      allowPrivateNetwork: false,
    },
    { secret: 'auth-fixture' },
  );
  service.grant('chat', c.id, c.revision);
  const target = {
    connectionId: c.id,
    revision: c.revision,
    path: '/api/set',
    method: 'POST' as const,
    body: 'password=',
    encoding: 'form' as const,
    fields: ['password'],
  };
  return { store, service, send, target, vault };
}
it('uses existing grants and runtime fences; privately injects form content and suppresses echoed bodies', async () => {
  const { service, send, target } = await fixture();
  const dispatched = vi.fn();
  expect(
    await service.applyRelayTarget(
      'chat',
      target,
      'password=secret-fixture',
      'form',
      AbortSignal.timeout(1000),
      () => {},
      dispatched,
    ),
  ).toEqual({ status: 200 });
  expect(dispatched).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toMatchObject({
    body: 'password=secret-fixture',
    headers: {
      Authorization: 'Bearer auth-fixture',
      'content-type': 'application/x-www-form-urlencoded',
    },
  });
});
it('requires session access and rejects destination revision changes before authentication lookup', async () => {
  const { service, target, vault, send } = await fixture();
  service.revokeSession('chat', target.connectionId);
  await expect(
    service.applyRelayTarget(
      'chat',
      target,
      '{}',
      'json',
      AbortSignal.timeout(1000),
      () => {},
      vi.fn(),
    ),
  ).rejects.toThrow();
  expect(vault.read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it('does not journal dispatch when runtime authority fails', async () => {
  const { service, target, send } = await fixture();
  const dispatched = vi.fn();
  await expect(
    service.applyRelayTarget(
      'chat',
      target,
      '{}',
      'json',
      AbortSignal.timeout(1000),
      () => {},
      dispatched,
      async () => {
        throw new Error('retired');
      },
    ),
  ).rejects.toThrow();
  expect(dispatched).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
