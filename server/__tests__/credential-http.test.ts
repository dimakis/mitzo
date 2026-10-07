import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { isAllowedConnectionAddress, sendConnectionRequest } from '../credential-http.js';

it('blocks loopback, link-local, metadata, unspecified and mapped local IPs even for private connections', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '169.254.169.254',
    '224.0.0.1',
    '::',
    '::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])
    expect(isAllowedConnectionAddress(ip, true)).toBe(false);
});
it('requires explicit enrollment for private addresses', () => {
  for (const ip of [
    '10.0.1.2',
    '192.168.1.10',
    '172.16.0.1',
    'fc00::1',
    'fd12::1',
    '100.64.0.1',
    '100.127.255.254',
  ]) {
    expect(isAllowedConnectionAddress(ip, false)).toBe(false);
    expect(isAllowedConnectionAddress(ip, true)).toBe(true);
  }
  expect(isAllowedConnectionAddress('8.8.8.8', false)).toBe(true);
});
it('uses HTTPS with no redirect following, cookies, proxy or user-supplied headers', async () => {
  const outgoing = vi.fn(async () => ({ status: 302, body: 'redirect' }));
  await expect(
    sendConnectionRequest(
      {
        url: new URL('https://ha.example.com/api/'),
        method: 'GET',
        headers: { Authorization: 'Bearer secret' },
        allowPrivateNetwork: false,
      },
      new AbortController().signal,
      outgoing,
    ),
  ).rejects.toThrow('Redirects are unavailable');
  expect(outgoing).toHaveBeenCalled();
});

it('uses the reviewed public-address policy and only explicitly permitted LAN ranges', () => {
  for (const address of ['192.0.2.1', '198.18.0.1', '240.0.0.1', '2001:db8::1', '2002::1']) {
    expect(isAllowedConnectionAddress(address, false)).toBe(false);
    expect(isAllowedConnectionAddress(address, true)).toBe(false);
  }
});

const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: network.request }));
vi.mock('node:dns', () => ({ lookup: network.lookup }));
function input() {
  return {
    url: new URL('https://service.example/api/'),
    method: 'GET',
    headers: { Authorization: 'Bearer test-only' },
    allowPrivateNetwork: false,
  };
}
function response(status = 200) {
  const stream = new EventEmitter() as EventEmitter & {
    statusCode: number;
    destroy: ReturnType<typeof vi.fn>;
  };
  stream.statusCode = status;
  stream.destroy = vi.fn();
  return stream;
}
type CapturedLookup = (
  host: string,
  options: { all?: boolean },
  callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
) => void;
function transport() {
  const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  request.end = vi.fn();
  let opts: RequestOptions;
  let respond: (stream: ReturnType<typeof response>) => void;
  network.request.mockImplementationOnce((_url, options, callback) => {
    opts = options;
    respond = callback;
    options.signal.addEventListener('abort', () => request.emit('error', new Error('aborted')), {
      once: true,
    });
    return request;
  });
  return {
    request,
    options: () => opts!,
    respond: (stream: ReturnType<typeof response>) => respond!(stream),
  };
}
beforeEach(() => {
  network.request.mockReset();
  network.lookup.mockReset();
});
it('explicitly verifies certificates even if the process disables TLS verification', async () => {
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
  try {
    const mock = transport();
    const pending = sendConnectionRequest(input(), new AbortController().signal);
    expect(mock.options()).toMatchObject({ rejectUnauthorized: true, agent: false });
    const stream = response();
    mock.respond(stream);
    stream.emit('data', Buffer.from('ok'));
    stream.emit('end');
    await expect(pending).resolves.toEqual({ status: 200, body: 'ok' });
  } finally {
    vi.unstubAllEnvs();
  }
});
it('refuses redirects before attaching body readers or forwarding authentication', async () => {
  const mock = transport();
  const pending = sendConnectionRequest(input(), new AbortController().signal);
  const stream = response(302);
  mock.respond(stream);
  await expect(pending).rejects.toThrow('Redirects are unavailable');
  expect(stream.destroy).toHaveBeenCalled();
  expect(stream.listenerCount('data')).toBe(0);
  expect(network.request).toHaveBeenCalledTimes(1);
});
it('rejects responses larger than 64 KiB and never returns a truncated body', async () => {
  const mock = transport();
  const pending = sendConnectionRequest(input(), new AbortController().signal);
  const stream = response();
  mock.respond(stream);
  stream.emit('data', Buffer.alloc(64 * 1024));
  stream.emit('data', Buffer.from('x'));
  stream.emit('end');
  await expect(pending).rejects.toThrow('Connection response is too large');
  expect(stream.destroy).toHaveBeenCalled();
});
it('validates every DNS answer and pins the checked address list without a second lookup', async () => {
  const mock = transport();
  const pending = sendConnectionRequest(input(), new AbortController().signal);
  const answers = [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  network.lookup.mockImplementationOnce((_host, _options, callback) => callback(null, answers));
  const lookup = mock.options().lookup! as (
    host: string,
    options: { all: boolean },
    callback: ReturnType<typeof vi.fn>,
  ) => void;
  const callback = vi.fn();
  lookup('service.example', { all: true }, callback);
  expect(network.lookup).toHaveBeenCalledExactlyOnceWith(
    'service.example',
    { all: true },
    expect.any(Function),
  );
  expect(callback).toHaveBeenCalledWith(null, answers);
  const stream = response();
  mock.respond(stream);
  stream.emit('end');
  await pending;
});
it('rejects mixed unsafe DNS answers, resolver errors, excessive answers and inconsistent families', async () => {
  for (const answers of [
    [],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    Array.from({ length: 17 }, () => ({ address: '8.8.8.8', family: 4 })),
    [{ address: '8.8.8.8', family: 6 }],
    [{ address: '::ffff:8.8.8.8', family: 6 }],
  ]) {
    const mock = transport();
    const pending = sendConnectionRequest(input(), new AbortController().signal);
    network.lookup.mockImplementationOnce((_host, _options, callback) => callback(null, answers));
    const lookup = mock.options().lookup! as (
      host: string,
      options: object,
      callback: ReturnType<typeof vi.fn>,
    ) => void;
    const callback = vi.fn();
    lookup('service.example', {}, callback);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    mock.request.emit('error', callback.mock.calls[0][0]);
    await expect(pending).rejects.toThrow();
  }
  const mock = transport();
  const pending = sendConnectionRequest(input(), new AbortController().signal);
  network.lookup.mockImplementationOnce((_host, _options, callback) =>
    callback(new Error('dns failed'), undefined),
  );
  const callback = vi.fn();
  (mock.options().lookup! as CapturedLookup)('service.example', {}, callback);
  mock.request.emit('error', callback.mock.calls[0][0]);
  await expect(pending).rejects.toThrow('dns failed');
});
it('pins a single checked DNS result for callers not requesting all answers', async () => {
  const mock = transport();
  const pending = sendConnectionRequest(input(), new AbortController().signal);
  const answers: LookupAddress[] = [{ address: '8.8.8.8', family: 4 }];
  network.lookup.mockImplementationOnce((_host, _options, callback) => callback(null, answers));
  const callback = vi.fn();
  (mock.options().lookup! as CapturedLookup)('service.example', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  const stream = response();
  mock.respond(stream);
  stream.emit('end');
  await pending;
});
it('does not create a request for pre-cancelled calls and propagates active cancellation', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(sendConnectionRequest(input(), cancelled.signal)).rejects.toThrow();
  expect(network.request).not.toHaveBeenCalled();
  const mock = transport();
  const controller = new AbortController();
  const pending = sendConnectionRequest(input(), controller.signal);
  expect(mock.options().signal).toBe(controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});
it('blocks unsafe literal destinations before HTTPS dispatch even for private enrollment', async () => {
  for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '169.254.169.254']) {
    await expect(
      sendConnectionRequest(
        { ...input(), url: new URL(`https://${host}/api/`), allowPrivateNetwork: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Destination is unavailable');
  }
  expect(network.request).not.toHaveBeenCalled();
});

it('permits enrolled private DNS answers and blocks the same answers without enrollment', async () => {
  for (const allowPrivateNetwork of [false, true]) {
    const mock = transport();
    const pending = sendConnectionRequest(
      { ...input(), allowPrivateNetwork },
      new AbortController().signal,
    );
    const answers = [
      { address: '192.168.1.10', family: 4 },
      { address: 'fd12::1', family: 6 },
    ];
    network.lookup.mockImplementationOnce((_host, _options, callback) => callback(null, answers));
    const callback = vi.fn();
    (mock.options().lookup! as CapturedLookup)('service.example', { all: true }, callback);
    if (allowPrivateNetwork) {
      expect(callback).toHaveBeenCalledWith(null, answers);
      const stream = response();
      mock.respond(stream);
      stream.emit('end');
      await pending;
    } else {
      expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
      mock.request.emit('error', callback.mock.calls[0][0]);
      await expect(pending).rejects.toThrow('Destination is unavailable');
    }
  }
});
it('refuses cancelled results even when an injected sender ignores caller cancellation', async () => {
  const controller = new AbortController();
  const sender = vi.fn(async () => {
    controller.abort();
    return { status: 200, body: 'should not return' };
  });
  await expect(sendConnectionRequest(input(), controller.signal, sender)).rejects.toThrow();
});
