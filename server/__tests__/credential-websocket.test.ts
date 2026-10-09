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
    },
    controller.signal,
    (_url, o) => {
      options = o;
      return socket as unknown as WebSocket;
    },
  );
  return { socket, pending, check, controller, options: () => options };
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
