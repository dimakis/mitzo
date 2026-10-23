import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { sendPrivateBrowserRequest } from '../secret-relay-browser-driver.js';
import { BrowserRelayTargetSchema } from '../secret-relay-browser.js';
const target = BrowserRelayTargetSchema.parse({
  adapter: 'browser',
  origin: 'https://service.example',
  requests: [
    { path: '/login', methods: ['GET', 'POST'] },
    { path: '/whoami', methods: ['GET'] },
  ],
  login: { path: '/login', passwordSelector: '#password', submitSelector: '#login' },
  verification: { path: '/whoami', pointer: '/authenticated', equals: true },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockImplementation((_url, options, respond) => {
    const req = new EventEmitter() as EventEmitter & { end: (body?: Buffer) => void };
    req.end = () => {
      options.lookup('service.example', { all: true }, (err: Error | null, addresses: unknown) => {
        if (err) {
          req.emit('error', err);
          return;
        }
        if (!Array.isArray(addresses)) {
          req.emit('error', new Error('all:true requires address records'));
          return;
        }
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: () => void;
        };
        res.statusCode = 200;
        res.headers = { 'content-type': 'text/html', 'set-cookie': 'private=session; Secure' };
        res.destroy = () => {};
        respond(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from('private page'));
          res.emit('end');
        });
      });
    };
    return req;
  });
});
it('handles Node all-address lookup while pinning one checked DNS result and preserving private cookies', async () => {
  const response = await sendPrivateBrowserRequest(
    target,
    'https://service.example/login',
    'POST',
    { cookie: 'private=session', host: 'attacker', 'proxy-authorization': 'private' },
    Buffer.from('password=private'),
    { signal: AbortSignal.timeout(1000), check: () => {}, dispatched: () => {} },
  );
  expect(response.headers['set-cookie']).toBe('private=session; Secure');
  const options = mocks.request.mock.calls[0][1];
  expect(options.headers).toEqual({
    cookie: 'private=session',
    'accept-encoding': 'identity',
    'content-length': '16',
  });
  expect(options.rejectUnauthorized).toBe(true);
  expect(mocks.lookup).toHaveBeenCalledOnce();
});
it('denies mixed DNS and rechecks changed runtime authority during the actual socket lookup', async () => {
  const gate = {
    signal: AbortSignal.timeout(1000),
    check: () => {},
    dispatched: () => {},
    assertCurrent: vi.fn(async () => {}),
  };
  mocks.lookup.mockResolvedValueOnce([
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(
    sendPrivateBrowserRequest(target, 'https://service.example/login', 'GET', {}, undefined, gate),
  ).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
  gate.assertCurrent.mockImplementation(async () => {
    if (gate.assertCurrent.mock.calls.length === 2) throw new Error('retired');
  });
  await expect(
    sendPrivateBrowserRequest(target, 'https://service.example/login', 'GET', {}, undefined, gate),
  ).rejects.toThrow('Private browser request failed');
});
it('rechecks a request scope after asynchronous authority before constructing the HTTPS request', async () => {
  let active = true;
  const gate = {
    signal: AbortSignal.timeout(1000),
    check: () => {
      if (!active) throw new Error('scope ended');
    },
    dispatched: () => {},
    assertCurrent: async () => {
      active = false;
    },
  };
  await expect(
    sendPrivateBrowserRequest(
      target,
      'https://service.example/login',
      'POST',
      {},
      Buffer.from('private'),
      gate,
    ),
  ).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});
