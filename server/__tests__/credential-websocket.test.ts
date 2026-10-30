import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import {
  websocketRequest,
  WebSocketConfigSchema,
  type ConnectionSocketOptions,
} from '../credential-websocket.js';
class Socket extends EventEmitter {
  sent: string[] = [];
  send = vi.fn((text: string) => this.sent.push(text));
  terminate = vi.fn();
  receive(body: string, binary = false) {
    this.emit('message', Buffer.from(body), binary);
  }
}
function fixture(
  authentication: unknown = { kind: 'headers' },
  request: unknown = { message: '{"op":"update"}' },
  assertRuntimeCurrent?: () => Promise<void>,
) {
  const socket = new Socket();
  const controller = new AbortController();
  const check = vi.fn();
  let options!: ConnectionSocketOptions;
  const pending = websocketRequest(
    {
      url: new URL('wss://service.example.com/socket'),
      token: 'fixture-private-token',
      headers: { Authorization: 'Bearer fixture-private-token' },
      allowPrivateNetwork: false,
      config: WebSocketConfigSchema.parse({ path: '/socket', authentication }),
      request: request as never,
      check,
      assertRuntimeCurrent,
    },
    controller.signal,
    (_url, o) => {
      options = o;
      return socket as unknown as WebSocket;
    },
  );
  return { socket, pending, check, controller, options: () => options };
}
async function nativeFixture(authentication?: unknown, request?: unknown) {
  const guard = vi.fn(async () => {});
  const f = fixture(authentication, request, guard);
  await vi.waitFor(() => expect(f.options()).toBeDefined());
  f.socket.emit('open');
  await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
  const outcome = f.pending.then(
    (body) => ({ body }),
    (error: unknown) => ({ error }),
  );
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = guard.mock.calls.length;
  return { ...f, guard, outcome, barrier, release, before };
}
afterEach(() => vi.useRealTimers());
it('supports a non-HA service over authenticated WSS and cleans up after its reply', async () => {
  const f = fixture();
  expect(f.options()).toMatchObject({
    headers: { Authorization: 'Bearer fixture-private-token' },
    rejectUnauthorized: true,
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
  });
  expect(f.options().lookup).toBeTypeOf('function');
  f.socket.emit('open');
  expect(f.socket.sent).toEqual(['{"op":"update"}']);
  f.socket.receive('{"ok":true}');
  expect(await f.pending).toBe('{"ok":true}');
  expect(f.socket.terminate).toHaveBeenCalledOnce();
});
it('injects a private token into a configured JSON auth exchange before sending application data', async () => {
  const f = fixture(
    {
      kind: 'json',
      message: '{"type":"login"}',
      credentialField: 'token',
      challenge: { field: 'type', equals: 'hello' },
      success: { field: 'type', equals: 'ready' },
    },
    { message: '{"id":8,"op":"set"}', responseMatch: { field: 'id', equals: 8 } },
  );
  expect(f.options().headers).toEqual({});
  f.socket.emit('open');
  expect(f.socket.sent).toEqual([]);
  f.socket.receive('{"type":"hello"}');
  expect(JSON.parse(f.socket.sent[0])).toEqual({ type: 'login', token: 'fixture-private-token' });
  f.socket.receive('{"type":"ready"}');
  expect(f.socket.sent[1]).toBe('{"id":8,"op":"set"}');
  f.socket.receive('{"id":7,"event":"unrelated"}');
  f.socket.receive('{"id":8,"ok":true}');
  expect(await f.pending).toBe('{"id":8,"ok":true}');
});
it('fails authentication without sending application data and keeps private upstream errors out of failures', async () => {
  const f = fixture({
    kind: 'json',
    message: '{"type":"login"}',
    credentialField: 'token',
    success: { field: 'ok', equals: true },
  });
  f.socket.emit('open');
  f.socket.receive('{"ok":false,"error":"fixture-private-token"}');
  await expect(f.pending).rejects.toMatchObject({
    message: 'WebSocket request failed',
    mayHaveApplied: false,
  });
  expect(f.socket.sent).toHaveLength(1);
});
it('checks permission before every send and receive, cancels without replay, and marks a sent command unconfirmed', async () => {
  const f = fixture();
  f.socket.emit('open');
  f.controller.abort();
  await expect(f.pending).rejects.toMatchObject({ mayHaveApplied: true });
  expect(f.socket.sent).toHaveLength(1);
  const revoked = fixture();
  revoked.check.mockImplementation(() => {
    throw new Error('fixture-private-token');
  });
  revoked.socket.emit('open');
  await expect(revoked.pending).rejects.toMatchObject({ mayHaveApplied: false });
  expect(revoked.socket.sent).toHaveLength(0);
});
it('bounds binary, oversized and excessive frames and expires stalled exchanges', async () => {
  for (const kind of ['binary', 'size', 'count']) {
    const f = fixture(undefined, { message: '{}', responseMatch: { field: 'id', equals: 2 } });
    f.socket.emit('open');
    if (kind === 'binary') f.socket.receive('x', true);
    else if (kind === 'size') f.socket.receive('x'.repeat(256 * 1024 + 1));
    else for (let i = 0; i < 65; i++) f.socket.receive('{"id":1}');
    await expect(f.pending).rejects.toMatchObject({ mayHaveApplied: true });
  }
  vi.useFakeTimers();
  const f = fixture();
  const failure = expect(f.pending).rejects.toThrow('WebSocket request failed');
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
});
it('rejects unsafe authentication templates and reserved credential fields', () => {
  for (const credentialField of ['__proto__', 'constructor', 'prototype'])
    expect(() =>
      WebSocketConfigSchema.parse({
        path: '/socket',
        authentication: {
          kind: 'json',
          message: '{}',
          credentialField,
          success: { field: 'ok', equals: true },
        },
      }),
    ).toThrow();
  for (const message of ['null', '[]', '{"token":"hardcoded"}', '{"nested":{"password":"oops"}}'])
    expect(() =>
      WebSocketConfigSchema.parse({
        path: '/socket',
        authentication: {
          kind: 'json',
          message,
          credentialField: 'token',
          success: { field: 'ok', equals: true },
        },
      }),
    ).toThrow();
});

it('negotiates configured subprotocols and rejects duplicate or invalid names', async () => {
  const socket = new Socket();
  let options!: ConnectionSocketOptions;
  const config = WebSocketConfigSchema.parse({
    path: '/rpc',
    protocols: ['json-rpc'],
    authentication: { kind: 'headers' },
  });
  const pending = websocketRequest(
    {
      url: new URL('wss://rpc.example.com/rpc'),
      token: 'fixture',
      headers: { 'X-API-Key': 'fixture' },
      allowPrivateNetwork: false,
      config,
      request: { message: 'ping' },
      check() {},
    },
    new AbortController().signal,
    (_url, o) => {
      options = o;
      return socket as unknown as WebSocket;
    },
  );
  expect(options.protocols).toEqual(['json-rpc']);
  socket.emit('open');
  socket.receive('pong');
  expect(await pending).toBe('pong');
  for (const protocols of [['json', 'json'], ['bad protocol']])
    expect(() => WebSocketConfigSchema.parse({ ...config, protocols })).toThrow();
});

it('waits for final native authority before connecting and before every frame', async () => {
  const socket = new Socket();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let revoked = false;
  const guard = vi.fn(async () => {
    await barrier;
    if (revoked) throw Error('Native owner retired');
  });
  const factory = vi.fn(() => socket as unknown as WebSocket);
  const pending = websocketRequest(
    {
      url: new URL('wss://service.example.com/socket'),
      token: 'private',
      headers: { Authorization: 'Bearer private' },
      allowPrivateNetwork: false,
      config: { path: '/socket', authentication: { kind: 'headers' } },
      request: { message: '{"write":true}' },
      check: () => {},
      assertRuntimeCurrent: guard,
    },
    new AbortController().signal,
    factory,
  );
  const outcome = pending.catch((error) => error);
  expect(factory).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
  revoked = true;
  socket.emit('open');
  expect(await outcome).toMatchObject({ mayHaveApplied: false });
  expect(socket.send).not.toHaveBeenCalled();
});

it.each(['queued', 'checking'] as const)(
  'delivers a received reply after peer close while final authority is %s',
  async (phase) => {
    const f = await nativeFixture();
    f.guard.mockImplementationOnce(async () => {
      await f.barrier;
    });
    f.socket.receive('{"ok":true}');
    if (phase === 'checking')
      await vi.waitFor(() => expect(f.guard).toHaveBeenCalledTimes(f.before + 1));
    f.socket.emit('close');
    f.release();
    expect(await f.outcome).toEqual({ body: '{"ok":true}' });
    expect(f.socket.sent).toEqual(['{"op":"update"}']);
    expect(f.socket.terminate).toHaveBeenCalledOnce();
  },
);

it('does not send a queued command after peer close during authentication', async () => {
  const f = await nativeFixture({
    kind: 'json',
    message: '{"type":"login"}',
    credentialField: 'token',
    success: { field: 'ok', equals: true },
  });
  f.guard.mockImplementationOnce(async () => {
    await f.barrier;
  });
  f.socket.receive('{"ok":true}');
  await vi.waitFor(() => expect(f.guard).toHaveBeenCalledTimes(f.before + 1));
  f.socket.emit('close');
  f.release();
  expect(await f.outcome).toMatchObject({ error: { mayHaveApplied: false } });
  expect(f.socket.sent).toHaveLength(1);
});

it.each(['revocation', 'cancellation'] as const)(
  'still refuses a received reply during close drain after %s',
  async (reason) => {
    const f = await nativeFixture();
    f.guard.mockImplementationOnce(async () => {
      await f.barrier;
      if (reason === 'revocation') throw Error('private retired owner');
    });
    f.socket.receive('{"ok":true}');
    await vi.waitFor(() => expect(f.guard).toHaveBeenCalledTimes(f.before + 1));
    f.socket.emit('close');
    if (reason === 'cancellation') f.controller.abort();
    f.release();
    expect(await f.outcome).toMatchObject({
      error: {
        message: 'WebSocket request failed',
        mayHaveApplied: true,
      },
    });
    expect(f.socket.sent).toHaveLength(1);
  },
);

it('fails an incomplete closed exchange and ignores replies received after close', async () => {
  const f = await nativeFixture(undefined, {
    message: '{}',
    responseMatch: { field: 'id', equals: 2 },
  });
  f.socket.receive('{"id":1}');
  f.socket.emit('close');
  f.socket.receive('{"id":2}');
  expect(await f.outcome).toMatchObject({ error: { mayHaveApplied: true } });
});

it('retains the exchange deadline while a closed reply waits for authority', async () => {
  vi.useFakeTimers();
  const f = await nativeFixture();
  f.guard.mockImplementationOnce(async () => {
    await f.barrier;
  });
  f.socket.receive('{"ok":true}');
  await vi.waitFor(() => expect(f.guard).toHaveBeenCalledTimes(f.before + 1));
  f.socket.emit('close');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await f.outcome).toMatchObject({ error: { mayHaveApplied: true } });
  f.release();
});
