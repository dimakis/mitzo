import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialConnections,
  CredentialConnectionStore,
  ConnectionInputSchema,
  requestTarget,
  type ConnectionSender,
} from '../credential-connections.js';

const input = {
  label: 'Home Assistant',
  endpoint: 'https://ha.example.com',
  auth: { kind: 'bearer' },
  paths: ['/api/'],
  methods: ['GET', 'HEAD'],
  allowPrivateNetwork: false,
};
const stores: CredentialConnectionStore[] = [];
function setup() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const vault = {
    save: vi.fn(async () => ({ service: 'mitzo.connection.test', account: 'token' })),
    link: vi.fn(async () => ({ service: 'existing', account: 'user' })),
    read: vi.fn(async () => 'very-private-token'),
    remove: vi.fn(async () => {}),
  };
  const send = vi.fn<ConnectionSender>(async () => ({ status: 200, body: 'ok' }));
  const service = new CredentialConnections(store, vault, send);
  return { store, vault, send, service };
}
afterEach(() => stores.splice(0).forEach((s) => s.close()));

describe('credential connections', () => {
  it('stores references, exposes only metadata, and never resolves during discovery', async () => {
    const { store, vault, service } = setup();
    const connection = await service.create(input, { secret: 'very-private-token' });
    expect(JSON.stringify(service.catalog('session-a'))).not.toMatch(
      /very-private-token|mitzo.connection.test|credentialRef/,
    );
    expect(store.get(connection.id)?.credentialRef).toEqual({
      service: 'mitzo.connection.test',
      account: 'token',
    });
    expect(vault.read).not.toHaveBeenCalled();
    expect(service.catalog('session-a')[0].access).toBe('approval_required');
  });
  it('requires exact session approval before reading a secret or sending a request', async () => {
    const { service, vault, send } = setup();
    const c = await service.create(input, { secret: 'very-private-token' });
    await expect(
      service.request('a', c.id, { path: '/api/', method: 'GET' }, new AbortController().signal),
    ).rejects.toThrow('Session approval required');
    expect(vault.read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    service.grant('a', c.id, c.revision);
    expect(
      await service.request(
        'a',
        c.id,
        { path: '/api/', method: 'GET' },
        new AbortController().signal,
      ),
    ).toEqual({ status: 200, body: 'ok' });
    expect(send.mock.calls[0][0].headers).toEqual({ Authorization: 'Bearer very-private-token' });
    await expect(
      service.request('b', c.id, { path: '/api/', method: 'GET' }, new AbortController().signal),
    ).rejects.toThrow('Session approval required');
    expect(service.catalog('a')[0].access).toBe('approved');
    expect(service.catalog('fork-of-a')[0].access).toBe('approval_required');
  });
  it('persists session grants across service recreation, and revokes only the selected session', async () => {
    const { store, vault, send, service } = setup();
    const c = await service.create(input, { secret: 'secret' });
    service.grant('a', c.id, c.revision);
    service.grant('b', c.id, c.revision);
    const resumed = new CredentialConnections(store, vault, send);
    expect(resumed.catalog('a')[0].access).toBe('approved');
    resumed.revokeSession('a', c.id);
    expect(resumed.catalog('a')[0].access).toBe('approval_required');
    expect(resumed.catalog('b')[0].access).toBe('approved');
  });
  it('invalidates all grants when credentials rotate and rejects stale approvals', async () => {
    const { service } = setup();
    const c = await service.create(input, { secret: 'old' });
    service.grant('a', c.id, c.revision);
    const next = await service.rotate(c.id, c.revision, 'new');
    expect(next.revision).toBe(c.revision + 1);
    expect(service.catalog('a')[0].access).toBe('approval_required');
    expect(() => service.grant('b', c.id, c.revision)).toThrow('Connection changed');
  });
  it('links a specific existing item without enumerating the keychain and never deletes linked items', async () => {
    const { service, vault } = setup();
    const c = await service.create(input, { existing: { service: 'existing', account: 'user' } });
    expect(vault.link).toHaveBeenCalledWith({ service: 'existing', account: 'user' });
    service.disable(c.id, c.revision);
    expect(vault.remove).not.toHaveBeenCalled();
    expect(service.catalog('a')[0].status).toBe('disabled');
  });
  it('checks bounds before resolving credentials, including disallowed writes and escaped destinations', async () => {
    const { service, vault } = setup();
    const c = await service.create(input, { secret: 'secret' });
    service.grant('a', c.id, c.revision);
    for (const path of [
      'https://evil.com/api/',
      '//evil.com/api/',
      '/api/../admin',
      '/api/%2e%2e/admin',
      '/api/\\evil',
      '/apievil/',
      '/api/#fragment',
    ]) {
      await expect(
        service.request('a', c.id, { path, method: 'GET' }, new AbortController().signal),
      ).rejects.toThrow();
    }
    await expect(
      service.request(
        'a',
        c.id,
        { path: '/api/', method: 'POST', body: '{}' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(vault.read).not.toHaveBeenCalled();
  });
  it.each([
    [
      { kind: 'basic', username: 'alice' },
      { Authorization: `Basic ${Buffer.from('alice:very-private-token').toString('base64')}` },
    ],
    [{ kind: 'api-key', headerName: 'X-API-Key' }, { 'X-API-Key': 'very-private-token' }],
    [{ kind: 'password', headerName: 'X-Password' }, { 'X-Password': 'very-private-token' }],
  ])('supports typed authentication %j', async (auth, headers) => {
    const { service, send } = setup();
    const c = await service.create({ ...input, auth }, { secret: 'secret' });
    service.grant('a', c.id, c.revision);
    await service.request(
      'a',
      c.id,
      { path: '/api/', method: 'GET' },
      new AbortController().signal,
    );
    expect(send.mock.calls[0][0].headers).toEqual(headers);
  });
  it('redacts echoed credentials and transport errors', async () => {
    const { service, send } = setup();
    const c = await service.create(input, { secret: 'secret' });
    service.grant('a', c.id, c.revision);
    send.mockResolvedValueOnce({
      status: 200,
      body: 'very-private-token Bearer very-private-token',
    });
    expect(
      JSON.stringify(
        await service.request(
          'a',
          c.id,
          { path: '/api/', method: 'GET' },
          new AbortController().signal,
        ),
      ),
    ).not.toContain('very-private-token');
    send.mockRejectedValueOnce(new Error('very-private-token'));
    await expect(
      service.request('a', c.id, { path: '/api/', method: 'GET' }, new AbortController().signal),
    ).rejects.toThrow(/^Connection request failed$/);
  });
  it('fails closed when access is revoked during credential lookup', async () => {
    const { service, vault, send } = setup();
    const c = await service.create(input, { secret: 'secret' });
    service.grant('a', c.id, c.revision);
    vault.read.mockImplementationOnce(async () => {
      service.revokeSession('a', c.id);
      return 'secret';
    });
    await expect(
      service.request('a', c.id, { path: '/api/', method: 'GET' }, new AbortController().signal),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('cancels in-flight requests when session access is revoked', async () => {
    const { service, send } = setup();
    const c = await service.create(input, { secret: 'secret' });
    service.grant('a', c.id, c.revision);
    send.mockImplementationOnce(async (_request, signal) => {
      service.revokeSession('a', c.id);
      expect(signal.aborted).toBe(true);
      return { status: 200, body: 'late' };
    });
    await expect(
      service.request('a', c.id, { path: '/api/', method: 'GET' }, new AbortController().signal),
    ).rejects.toThrow();
  });
  it('rejects insecure destinations and unsafe headers at enrollment', () => {
    for (const endpoint of [
      'http://ha.example.com',
      'https://user:pass@ha.example.com',
      'https://ha.example.com/api',
      'https://ha.example.com?x=1',
    ])
      expect(ConnectionInputSchema.safeParse({ ...input, endpoint }).success).toBe(false);
    for (const headerName of [
      'Host',
      'Cookie',
      'Proxy-Authorization',
      'Content-Length',
      'X-Test\r\nHost',
    ])
      expect(
        ConnectionInputSchema.safeParse({ ...input, auth: { kind: 'api-key', headerName } })
          .success,
      ).toBe(false);
    expect(requestTarget(input, '/api/states?filter=a%20b').origin).toBe(input.endpoint);
  });
});

it('retains a rotated credential when another connection explicitly links that Keychain item', async () => {
  const { service, vault, store } = setup();
  const original = await service.create(input, { secret: 'original' });
  const ref = store.get(original.id)!.credentialRef;
  vault.link.mockResolvedValueOnce(ref);
  const linked = await service.create(input, { existing: ref });
  await service.rotate(original.id, original.revision, 'replacement');
  expect(vault.remove).not.toHaveBeenCalled();
  expect(store.get(linked.id)?.credentialRef).toEqual(ref);
});

it('lets an operator explicitly replace a credential after a failed rotation without restoring grants', async () => {
  const { service, vault, store } = setup();
  const c = await service.create(input, { secret: 'old' });
  service.grant('session', c.id, c.revision);
  vault.save.mockRejectedValueOnce(new Error('Keychain locked'));
  await expect(service.rotate(c.id, c.revision, 'replacement')).rejects.toThrow();
  const disabled = store.get(c.id)!;
  expect(disabled.status).toBe('disabled');
  const repaired = await service.rotate(c.id, disabled.revision, 'replacement');
  expect(repaired.status).toBe('active');
  expect(repaired.revision).toBe(disabled.revision + 1);
  expect(service.catalog('session')[0].access).toBe('approval_required');
});

it('rejects stale rotation completion without overwriting a newer credential revision or grant', async () => {
  const { service, store, vault, send } = setup();
  const c = await service.create(input, { secret: 'old' });
  let finishFirst!: (ref: { service: string; account: string }) => void;
  vault.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  const first = service.rotate(c.id, c.revision, 'first');
  const firstResult = expect(first).rejects.toThrow('Connection changed');
  const disabled = store.get(c.id)!;
  const secondService = new CredentialConnections(store, vault, send);
  const newestRef = { service: 'mitzo.connection.newest', account: 'newest' };
  vault.save.mockResolvedValueOnce(newestRef);
  const newest = await secondService.rotate(c.id, disabled.revision, 'newest');
  secondService.grant('approved-newest', c.id, newest.revision);
  const staleRef = { service: 'mitzo.connection.stale', account: 'stale' };
  finishFirst(staleRef);
  await firstResult;
  expect(store.get(c.id)?.revision).toBe(newest.revision);
  expect(store.get(c.id)?.credentialRef).toEqual(newestRef);
  expect(secondService.catalog('approved-newest')[0].access).toBe('approved');
  expect(vault.remove).toHaveBeenCalledWith(staleRef);
  expect(vault.remove).not.toHaveBeenCalledWith(newestRef);
});

it.each(['pa"ss\\word', 'sëcret', 'slash/secret', 'tab\tsecret', '"'])(
  'redacts JSON string escapes of credential %j including keys and authentication echoes',
  async (secret) => {
    const { service, vault, send } = setup();
    const c = await service.create(input, { secret });
    vault.read.mockResolvedValueOnce(secret);
    service.grant('a', c.id, c.revision);
    // Force mixed escapes rather than only JSON.stringify's canonical spelling.
    const escaped = JSON.stringify({ [secret]: secret, nested: [`Bearer ${secret}`, 'safe'] })
      .replaceAll('/', '\\/')
      .replaceAll('ë', '\\u00eb');
    send.mockResolvedValueOnce({ status: 200, body: escaped });
    const result = await service.request(
      'a',
      c.id,
      { path: '/api/', method: 'GET' },
      new AbortController().signal,
    );
    const decoded = JSON.parse(result.body);
    expect(decoded).toEqual({ '[redacted]': '[redacted]', nested: ['[redacted]', 'safe'] });
    expect(JSON.stringify(decoded)).not.toContain(JSON.stringify(secret).slice(1, -1));
  },
);

it.each([
  ['123456', '123456', '123457'],
  ['-123456', '-123456', '123456'],
  ['123.456', '1.23456e2', '123.457'],
  ['-1.23456e2', '-123.4560', '-123.457'],
  ['9007199254740992', '9007199254740992', '9007199254740993'],
  ['1e400', '10e399', '2e400'],
])(
  'redacts numeric JSON echoes of credential %j without rounding other values',
  async (secret, echo, other) => {
    const { service, vault, send } = setup();
    const c = await service.create(input, { secret });
    vault.read.mockResolvedValue(secret);
    service.grant('a', c.id, c.revision);
    send.mockResolvedValueOnce({
      status: 200,
      body: `{"token":${echo},"nested":[${echo},${other}],"text":"safe ${other}"}`,
    });
    const result = await service.request(
      'a',
      c.id,
      { path: '/api/', method: 'GET' },
      new AbortController().signal,
    );
    expect(result.body).toBe(
      `{"token":"[redacted]","nested":["[redacted]",${other}],"text":"safe ${other}"}`,
    );
    expect(JSON.parse(result.body).token).toBe('[redacted]');
    send.mockResolvedValueOnce({ status: 200, body: echo });
    expect(
      (
        await service.request(
          'a',
          c.id,
          { path: '/api/', method: 'GET' },
          new AbortController().signal,
        )
      ).body,
    ).toBe('"[redacted]"');
  },
);

it.each(['true', 'false', 'null'])(
  'redacts JSON keyword echoes of credential %j',
  async (secret) => {
    const { service, vault, send } = setup();
    const c = await service.create(input, { secret });
    vault.read.mockResolvedValue(secret);
    service.grant('a', c.id, c.revision);
    const unmatched = ['true', 'false', 'null'].filter((value) => value !== secret).join(',');
    send.mockResolvedValueOnce({
      status: 200,
      body: `{"token":${secret},"nested":[${secret},${unmatched},123],"text":"safe"}`,
    });
    const result = await service.request(
      'a',
      c.id,
      { path: '/api/', method: 'GET' },
      new AbortController().signal,
    );
    expect(result.body).toBe(
      `{"token":"[redacted]","nested":["[redacted]",${unmatched},123],"text":"safe"}`,
    );
    expect(JSON.parse(result.body).token).toBe('[redacted]');
    send.mockResolvedValueOnce({ status: 200, body: secret });
    expect(
      (
        await service.request(
          'a',
          c.id,
          { path: '/api/', method: 'GET' },
          new AbortController().signal,
        )
      ).body,
    ).toBe('"[redacted]"');
  },
);

it('keeps a connection disabled when a newer pending replacement fails and an older save completes', async () => {
  const { service, store, vault } = setup();
  const c = await service.create(input, { secret: 'old' });
  let finish!: (ref: { service: string; account: string }) => void;
  vault.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const older = service.rotate(c.id, c.revision, 'older');
  const olderResult = expect(older).rejects.toThrow('Connection changed');
  const pending = store.get(c.id)!;
  vault.save.mockRejectedValueOnce(new Error('Keychain locked'));
  await expect(service.rotate(c.id, pending.revision, 'newer')).rejects.toThrow('Keychain locked');
  const failed = store.get(c.id)!;
  finish({ service: 'mitzo.connection.stale', account: 'older' });
  await olderResult;
  expect(store.get(c.id)).toEqual(failed);
  expect(failed.status).toBe('disabled');
  expect(service.sessions(c.id)).toEqual([]);
});
