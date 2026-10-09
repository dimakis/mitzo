import { afterEach, expect, it, vi } from 'vitest';
import {
  CredentialConnections,
  CredentialConnectionStore,
  type ConnectionSender,
} from '../credential-connections.js';
import { PrepareConnectionSetupSchema } from '../credential-setup.js';

const stores: CredentialConnectionStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const vault = {
    save: vi.fn(async () => ({ service: 'test-service', account: 'test-account' })),
    read: vi.fn(async () => 'private-key'),
    link: vi.fn(),
    remove: vi.fn(async () => {}),
  };
  const send = vi.fn<ConnectionSender>(async (request) =>
    request.headers.Authorization
      ? { status: 200, body: '{"message":"API running."}' }
      : { status: 401, body: 'Unauthorized' },
  );
  const service = new CredentialConnections(store, vault, send);
  return { store, vault, send, service };
}
const input = {
  profile: 'home-assistant',
  endpoint: 'https://ha.example.com',
  access: 'read-write',
};
it('prepares durable secret-free Home Assistant setup scoped to the exact originating session', () => {
  const { service, store, vault, send } = fixture();
  const setup = service.setups.prepare('chat-a', input);
  expect(setup).toMatchObject({
    sessionId: 'chat-a',
    status: 'pending',
    revision: 1,
    connection: {
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      homeAssistantDashboards: 'read-write',
      websocket: {
        path: '/api/websocket',
        authentication: { kind: 'json', credentialField: 'access_token' },
      },
    },
  });
  expect(service.setups.status('chat-a', setup.id)).toEqual(setup);
  expect(() => service.setups.status('chat-b', setup.id)).toThrow('Setup unavailable');
  const resumed = new CredentialConnections(store, vault, send);
  expect(resumed.setups.status('chat-a', setup.id)).toEqual(setup);
  expect(vault.save).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it('verifies authentication before storing credentials, then requires separate exact-session access approval', async () => {
  const { service, send, vault } = fixture();
  const setup = service.setups.prepare('chat-a', input);
  const ready = await service.setups.complete(
    setup.id,
    setup.revision,
    'private-key',
    new AbortController().signal,
  );
  expect(ready).toMatchObject({ status: 'ready', revision: 3 });
  expect(send.mock.calls.map(([r]) => r.headers)).toEqual([
    {},
    { Authorization: 'Bearer private-key' },
  ]);
  expect(vault.save).toHaveBeenCalledOnce();
  expect(service.catalog('chat-a')[0]).toMatchObject({
    id: ready.connectionId,
    access: 'approval_required',
  });
  expect(JSON.stringify(ready)).not.toMatch(/private-key|credentialRef|test-service/);
  expect(
    await service.setups.complete(
      setup.id,
      ready.revision,
      'another-key',
      new AbortController().signal,
    ),
  ).toEqual(ready);
  expect(vault.save).toHaveBeenCalledOnce();
});
it('rejects public success as authentication proof and retries failed setup without an active orphan', async () => {
  const { service, send, vault } = fixture();
  const setup = service.setups.prepare('chat-a', input);
  send.mockResolvedValueOnce({ status: 200, body: '{"message":"API running."}' });
  const failed = await service.setups.complete(
    setup.id,
    1,
    'private-key',
    new AbortController().signal,
  );
  expect(failed).toMatchObject({ status: 'pending', revision: 3, error: expect.any(String) });
  expect(service.catalog()).toEqual([]);
  expect(vault.save).not.toHaveBeenCalled();
  const ready = await service.setups.complete(
    setup.id,
    failed.revision,
    'private-key',
    new AbortController().signal,
  );
  expect(ready.status).toBe('ready');
});
it('rejects invalid HA proof, sanitizes errors, and never stores failed credential values', async () => {
  const { service, send, vault } = fixture();
  const setup = service.setups.prepare('chat-a', input);
  send
    .mockResolvedValueOnce({ status: 401, body: '' })
    .mockRejectedValueOnce(new Error('private-key transport error'));
  const failed = await service.setups.complete(
    setup.id,
    1,
    'private-key',
    new AbortController().signal,
  );
  expect(JSON.stringify(failed)).not.toContain('private-key');
  expect(vault.save).not.toHaveBeenCalled();
  send
    .mockResolvedValueOnce({ status: 401, body: '' })
    .mockResolvedValueOnce({ status: 200, body: '<html>Login</html>' });
  expect(
    (
      await service.setups.complete(
        setup.id,
        failed.revision,
        'private-key',
        new AbortController().signal,
      )
    ).status,
  ).toBe('pending');
});
it('claims completion exactly once and rejects cancellation or stale revisions while verification is active', async () => {
  const { service, send, vault } = fixture();
  const setup = service.setups.prepare('chat-a', input);
  let resume!: (response: { status: number; body: string }) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resume = resolve;
      }),
  );
  const operation = service.setups.complete(
    setup.id,
    1,
    'private-key',
    new AbortController().signal,
  );
  expect(service.setups.browserStatus(setup.id).status).toBe('verifying');
  await expect(
    service.setups.complete(setup.id, 1, 'other', new AbortController().signal),
  ).rejects.toThrow('Setup changed');
  expect(() => service.setups.cancel(setup.id, 2)).toThrow('Setup changed');
  resume({ status: 401, body: '' });
  expect((await operation).status).toBe('ready');
  expect(vault.save).toHaveBeenCalledOnce();
});
it('expires and cancels setups before any secret lookup or network call', async () => {
  const { service, send, vault } = fixture();
  const setup = service.setups.prepare('chat-a', input);
  expect(service.setups.cancel(setup.id, 1).status).toBe('cancelled');
  await expect(
    service.setups.complete(setup.id, 2, 'private-key', new AbortController().signal),
  ).rejects.toThrow('Setup unavailable');
  const expiring = service.setups.prepare('chat-b', input);
  vi.spyOn(Date, 'now').mockReturnValue(expiring.expiresAt + 1);
  expect(service.setups.status('chat-b', expiring.id).status).toBe('expired');
  vi.restoreAllMocks();
  expect(send).not.toHaveBeenCalled();
  expect(vault.save).not.toHaveBeenCalled();
});
it('requires documented custom authentication and rejects tokens, credentialed URLs and unsafe verification paths', () => {
  const { service } = fixture();
  expect(PrepareConnectionSetupSchema.safeParse({ ...input, secret: 'private-key' }).success).toBe(
    false,
  );
  expect(
    PrepareConnectionSetupSchema.safeParse({ ...input, endpoint: 'https://token@ha.example.com' })
      .success,
  ).toBe(false);
  expect(() =>
    service.setups.prepare('a', { profile: 'custom', endpoint: 'https://api.example.com' }),
  ).toThrow();
  const custom = {
    profile: 'custom',
    endpoint: 'https://api.example.com',
    custom: {
      auth: { kind: 'api-key', headerName: 'X-API-Key' },
      paths: ['/api/'],
      methods: ['GET'],
      verificationPath: '/api/me',
      evidenceUrl: 'https://docs.example.com/auth',
      success: { field: 'id', type: 'string' },
    },
  };
  expect(service.setups.prepare('a', custom).connection.auth).toEqual({
    kind: 'api-key',
    headerName: 'X-API-Key',
  });
  expect(() =>
    service.setups.prepare('a', {
      ...custom,
      custom: { ...custom.custom, verificationPath: 'https://evil.example' },
    }),
  ).toThrow();
});
it('does not enroll if the originating session loses authority during asynchronous verification', async () => {
  const { service, send, vault } = fixture();
  const setup = service.setups.prepare('chat-a', input);
  let allowed = true;
  send.mockImplementationOnce(async () => {
    allowed = false;
    return { status: 401, body: '' };
  });
  expect(
    (
      await service.setups.complete(
        setup.id,
        1,
        'private-key',
        new AbortController().signal,
        () => allowed,
      )
    ).status,
  ).toBe('pending');
  expect(vault.save).not.toHaveBeenCalled();
});
it('read-only Home Assistant setup never enables arbitrary WebSocket commands', async () => {
  const { service } = fixture();
  const draft = service.setups.prepare('chat-a', {
    profile: 'home-assistant',
    endpoint: 'https://ha.example.com',
    access: 'read',
  });
  expect(draft.connection.methods).toEqual(['GET', 'HEAD']);
  expect(draft.connection.homeAssistantDashboards).toBe('read');
  expect(draft.connection.websocket).toBeNull();
});
it('retains pending completion delivery across restart and marks it delivered durably', async () => {
  const { service, store, vault, send } = fixture();
  const draft = service.setups.prepare('chat-a', input);
  const ready = await service.setups.complete(
    draft.id,
    1,
    'private-key',
    new AbortController().signal,
  );
  const resumed = new CredentialConnections(store, vault, send);
  expect(resumed.setups.pendingReady()).toEqual([ready]);
  resumed.setups.markDelivered(ready.id);
  expect(service.setups.pendingReady()).toEqual([]);
});
it('removes the enrolled credential if setup persistence loses its revision after successful verification', async () => {
  const { service, store, vault } = fixture();
  const draft = service.setups.prepare('chat-a', input);
  const replace = store.replaceSetupAtRevision.bind(store);
  vi.spyOn(store, 'replaceSetupAtRevision').mockImplementation((setup, revision) =>
    setup.status === 'ready' ? false : replace(setup, revision),
  );
  expect(
    (await service.setups.complete(draft.id, 1, 'private-key', new AbortController().signal))
      .status,
  ).toBe('pending');
  expect(service.catalog()).toEqual([]);
  expect(vault.remove).toHaveBeenCalledOnce();
});
it('rolls back both connection metadata and its saved key when ready persistence throws', async () => {
  const { service, store, vault } = fixture();
  const draft = service.setups.prepare('chat-a', input);
  const put = store.putSetup.bind(store);
  vi.spyOn(store, 'putSetup').mockImplementation((setup) => {
    if (setup.status === 'ready') throw new Error('Database unavailable');
    put(setup);
  });
  expect(
    (await service.setups.complete(draft.id, 1, 'private-key', new AbortController().signal))
      .status,
  ).toBe('pending');
  expect(service.catalog()).toEqual([]);
  expect(vault.remove).toHaveBeenCalledOnce();
});
it('coalesces retries for the same session and normalized pending configuration only', () => {
  const { service } = fixture();
  const first = service.setups.prepare('chat-a', input);
  expect(
    service.setups.prepare('chat-a', {
      ...input,
      label: 'Home Assistant',
      allowPrivateNetwork: false,
    }),
  ).toEqual(first);
  expect(service.setups.prepare('chat-b', input).id).not.toBe(first.id);
  expect(service.setups.prepare('chat-a', { ...input, access: 'read' }).id).not.toBe(first.id);
  service.setups.cancel(first.id, 1);
  expect(service.setups.prepare('chat-a', input).id).not.toBe(first.id);
});
it('coalesces a repeated prepare while credential verification is active', async () => {
  const { service, send } = fixture();
  const first = service.setups.prepare('chat-a', input);
  let resume!: (value: { status: number; body: string }) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resume = resolve;
      }),
  );
  const completion = service.setups.complete(
    first.id,
    1,
    'private-key',
    new AbortController().signal,
  );
  expect(service.setups.prepare('chat-a', input)).toMatchObject({
    id: first.id,
    status: 'verifying',
  });
  resume({ status: 401, body: '' });
  await completion;
});
it('requires a documented custom JSON success selector and refuses HTML or structured error success', async () => {
  const { service, send, vault } = fixture();
  const custom = {
    profile: 'custom',
    endpoint: 'https://api.example.com',
    custom: {
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      methods: ['GET'],
      verificationPath: '/api/me',
      evidenceUrl: 'https://docs.example.com/auth',
      success: { field: 'id', type: 'string' },
    },
  };
  const missing = { ...custom, custom: { ...custom.custom, success: undefined } };
  expect(PrepareConnectionSetupSchema.safeParse(missing).success).toBe(false);
  expect(
    PrepareConnectionSetupSchema.safeParse({
      ...custom,
      custom: { ...custom.custom, success: { field: 'id', type: 'string', equals: 'user' } },
    }).success,
  ).toBe(false);
  const setup = service.setups.prepare('chat-a', custom);
  for (const body of [
    '<html>Login</html>',
    '{"error":"Sign in","id":"user"}',
    '{"id":null}',
    '{"id":""}',
  ]) {
    send
      .mockResolvedValueOnce({ status: 401, body: '' })
      .mockResolvedValueOnce({ status: 200, body });
    const current = service.setups.status('chat-a', setup.id);
    expect(
      (
        await service.setups.complete(
          setup.id,
          current.revision,
          'private-key',
          new AbortController().signal,
        )
      ).status,
    ).toBe('pending');
  }
  expect(vault.save).not.toHaveBeenCalled();
  send
    .mockResolvedValueOnce({ status: 401, body: '' })
    .mockResolvedValueOnce({ status: 200, body: '{"id":"user"}' });
  const current = service.setups.status('chat-a', setup.id);
  expect(
    (
      await service.setups.complete(
        setup.id,
        current.revision,
        'private-key',
        new AbortController().signal,
      )
    ).status,
  ).toBe('ready');
});
it('matches an exact documented JSON marker and preserves different verification profiles', async () => {
  const { service, send } = fixture();
  const custom = {
    profile: 'custom',
    endpoint: 'https://api.example.com',
    custom: {
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      methods: ['GET'],
      verificationPath: '/api/me',
      evidenceUrl: 'https://docs.example.com/auth',
      success: { field: 'authenticated', equals: true },
    },
  };
  const setup = service.setups.prepare('chat-a', custom);
  expect(
    service.setups.prepare('chat-a', {
      ...custom,
      custom: { ...custom.custom, success: { field: 'id', type: 'number' } },
    }).id,
  ).not.toBe(setup.id);
  send
    .mockResolvedValueOnce({ status: 401, body: '' })
    .mockResolvedValueOnce({ status: 200, body: '{"authenticated":false}' });
  expect(
    (await service.setups.complete(setup.id, 1, 'private-key', new AbortController().signal))
      .status,
  ).toBe('pending');
});
