import { afterEach, expect, it, vi } from 'vitest';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';
import type { WebSocketSender } from '../credential-websocket.js';
const stores: CredentialConnectionStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function fixture() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const vault = {
    save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
    link: vi.fn(),
    read: vi.fn(async () => 'fixture-private-token'),
    remove: vi.fn(),
  };
  const send = vi.fn<WebSocketSender>(async () => '{"ok":true}');
  const service = new CredentialConnections(store, vault, vi.fn(), undefined, send);
  const input = {
    label: 'Custom service',
    endpoint: 'https://service.example.com',
    auth: { kind: 'api-key', headerName: 'X-API-Key' },
    paths: ['/rpc/'],
    methods: ['GET'],
  };
  const websocket = { path: '/rpc/socket', authentication: { kind: 'headers' } };
  return { store, vault, send, service, input, websocket };
}
it('is disabled on existing connections and exact-revision setup invalidates all grants', async () => {
  const f = fixture();
  const c = await f.service.create(f.input, { secret: 'fixture' });
  expect(c.websocket).toBeNull();
  f.service.grant('a', c.id, 1);
  await expect(
    f.service.websocketRequest('a', c.id, { message: '{}' }, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.vault.read).not.toHaveBeenCalled();
  const next = f.service.updateWebSocket(c.id, 1, f.websocket);
  expect(next.revision).toBe(2);
  expect(f.service.sessions(c.id)).toEqual([]);
  expect(() => f.service.updateWebSocket(c.id, 1, f.websocket)).toThrow('Connection changed');
  await expect(
    f.service.websocketRequest('a', c.id, { message: '{}' }, new AbortController().signal),
  ).rejects.toThrow('Session approval');
  expect(f.vault.read).not.toHaveBeenCalled();
  f.service.grant('a', c.id, 2);
  const result = await f.service.websocketRequest(
    'a',
    c.id,
    { message: '{}' },
    new AbortController().signal,
  );
  expect(result).toBe('{"ok":true}');
  expect(f.send).toHaveBeenCalledWith(
    expect.objectContaining({
      url: new URL('wss://service.example.com/rpc/socket'),
      headers: { 'X-API-Key': 'fixture-private-token' },
    }),
    expect.any(AbortSignal),
  );
});
it('requires approved path and forbids overriding handshake headers before reading a secret', async () => {
  const f = fixture();
  for (const overrides of [
    { websocket: { ...f.websocket, path: '/outside' } },
    { auth: { kind: 'api-key', headerName: 'Sec-WebSocket-Protocol' }, websocket: f.websocket },
  ])
    await expect(
      f.service.create({ ...f.input, ...overrides }, { secret: 'fixture' }),
    ).rejects.toThrow();
  expect(f.vault.save).not.toHaveBeenCalled();
});
it('redacts replies and cancels in-flight operations on revocation or transport setup changes', async () => {
  const f = fixture();
  const c = await f.service.create({ ...f.input, websocket: f.websocket }, { secret: 'fixture' });
  f.service.grant('a', c.id, 1);
  f.send.mockResolvedValueOnce('{"token":"fixture-private-token"}');
  expect(
    await f.service.websocketRequest('a', c.id, { message: '{}' }, new AbortController().signal),
  ).not.toContain('fixture-private-token');
  for (const revoke of [true, false]) {
    f.service.grant('a', c.id, 1);
    let ready!: () => void;
    const started = new Promise<void>((r) => {
      ready = r;
    });
    f.send.mockImplementationOnce(
      (_input, signal) =>
        new Promise((_r, reject) => {
          ready();
          signal.addEventListener('abort', () => reject(new Error('private upstream failure')), {
            once: true,
          });
        }),
    );
    const pending = f.service.websocketRequest(
      'a',
      c.id,
      { message: '{}' },
      new AbortController().signal,
    );
    await started;
    if (revoke) f.service.revokeSession('a', c.id);
    else f.service.updateWebSocket(c.id, 1, null);
    await expect(pending).rejects.toThrow('WebSocket request failed');
  }
});
it('checks pending mode and cancellation again after asynchronous secret resolution', async () => {
  const f = fixture();
  const c = await f.service.create({ ...f.input, websocket: f.websocket }, { secret: 'fixture' });
  f.service.grant('a', c.id, 1);
  let allowed = true;
  f.vault.read.mockImplementationOnce(async () => {
    allowed = false;
    return 'fixture-private-token';
  });
  await expect(
    f.service.websocketRequest(
      'a',
      c.id,
      { message: '{}' },
      new AbortController().signal,
      () => allowed,
    ),
  ).rejects.toMatchObject({ mayHaveApplied: false });
  expect(f.send).not.toHaveBeenCalled();
});

it('reports credential-resolution failures as unsent without leaking their error text', async () => {
  const f = fixture();
  const c = await f.service.create({ ...f.input, websocket: f.websocket }, { secret: 'fixture' });
  f.service.grant('a', c.id, 1);
  f.vault.read.mockRejectedValueOnce(new Error('fixture-private-token'));
  await expect(
    f.service.websocketRequest('a', c.id, { message: '{}' }, new AbortController().signal),
  ).rejects.toMatchObject({ mayHaveApplied: false, message: 'WebSocket request failed' });
  expect(f.send).not.toHaveBeenCalled();
});
