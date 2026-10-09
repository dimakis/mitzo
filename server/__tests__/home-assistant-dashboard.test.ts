import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import {
  dashboardExchange,
  dashboardConfigHash,
  validateDashboardRequest,
  type DashboardSocketFactory,
  type DashboardSocketOptions,
  type DashboardSender,
} from '../home-assistant-dashboard.js';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';

class Socket extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  send = vi.fn((text: string) => {
    this.sent.push(JSON.parse(text));
  });
  terminate = vi.fn();
  receive(message: unknown, binary = false) {
    this.emit('message', Buffer.from(JSON.stringify(message)), binary);
  }
  result(value: unknown, success = true) {
    this.receive({ type: 'result', id: this.sent.at(-1)?.id, success, result: value });
  }
}
function exchange(request: Record<string, unknown> = { operation: 'read' }) {
  const socket = new Socket();
  let options: DashboardSocketOptions;
  const factory: DashboardSocketFactory = (_url, o) => {
    options = o;
    return socket as unknown as WebSocket;
  };
  const controller = new AbortController();
  const check = vi.fn();
  const pending = dashboardExchange(
    {
      url: new URL('wss://ha.example.com/api/websocket'),
      token: 'fixture-private-token',
      allowPrivateNetwork: false,
      request: request as never,
      check,
    },
    controller.signal,
    factory,
  );
  return { socket, controller, check, pending, options: () => options! };
}
function authenticate(socket: Socket) {
  socket.receive({ type: 'auth_required' });
  socket.receive({ type: 'auth_ok' });
}
it('authenticates privately, reads the exact named dashboard, and returns its change hash', async () => {
  const f = exchange({ operation: 'read', urlPath: 'my-dashboard' });
  expect(f.socket.sent).toEqual([]);
  expect(f.options()).toMatchObject({
    rejectUnauthorized: true,
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
  });
  expect(f.options().lookup).toBeTypeOf('function');
  authenticate(f.socket);
  expect(f.socket.sent).toEqual([
    { type: 'auth', access_token: 'fixture-private-token' },
    { id: 1, type: 'lovelace/config', force: true, url_path: 'my-dashboard' },
  ]);
  const config = { views: [{ title: 'Home', cards: [] }] };
  f.socket.result(config);
  expect(JSON.parse(await f.pending)).toEqual({
    operation: 'read',
    urlPath: 'my-dashboard',
    config,
    configHash: dashboardConfigHash(config),
  });
  expect(f.socket.terminate).toHaveBeenCalledOnce();
});
it('lists dashboards and supports the default dashboard without inventing its URL path', async () => {
  const list = exchange({ operation: 'list' });
  authenticate(list.socket);
  expect(list.socket.sent.at(-1)?.type).toBe('lovelace/dashboards/list');
  list.socket.result([{ url_path: 'home-dashboard', mode: 'storage' }]);
  expect(JSON.parse(await list.pending).dashboards).toHaveLength(1);
  const read = exchange();
  authenticate(read.socket);
  expect(read.socket.sent.at(-1)).not.toHaveProperty('url_path');
  read.socket.result({ views: [] });
  await read.pending;
});
it('checks the read hash before saving and verifies the complete configuration after the acknowledgement', async () => {
  const previous = { views: [{ title: 'Old', cards: [{ type: 'button' }] }] };
  const config = { views: [{ title: 'New', cards: [{ type: 'button' }] }] };
  const f = exchange({
    operation: 'save',
    config: JSON.stringify(config),
    expectedConfigHash: dashboardConfigHash(previous),
  });
  authenticate(f.socket);
  f.socket.result(previous);
  expect(f.socket.sent.at(-1)).toEqual({ id: 2, type: 'lovelace/config/save', config });
  f.socket.result(null);
  expect(f.socket.sent.at(-1)).toEqual({ id: 3, type: 'lovelace/config', force: true });
  f.socket.result(config);
  expect(JSON.parse(await f.pending)).toMatchObject({
    verified: true,
    configHash: dashboardConfigHash(config),
  });
});
it('never overwrites a dashboard that changed since the agent read it', async () => {
  const f = exchange({
    operation: 'save',
    config: '{}',
    expectedConfigHash: dashboardConfigHash({ views: [] }),
  });
  authenticate(f.socket);
  f.socket.result({ views: [{ title: 'Someone else edited this' }] });
  await expect(f.pending).rejects.toMatchObject({ code: 'DASHBOARD_CHANGED' });
  expect(f.socket.sent.some((frame) => frame.type === 'lovelace/config/save')).toBe(false);
});
it('reports a dropped or mismatching post-save result as uncertain without replaying a write', async () => {
  for (const mismatch of [false, true]) {
    const f = exchange({
      operation: 'save',
      config: '{"views":[{"title":"New"}]}',
      expectedConfigHash: dashboardConfigHash({ views: [] }),
    });
    authenticate(f.socket);
    f.socket.result({ views: [] });
    f.socket.result(null);
    if (mismatch) f.socket.result({ views: [{ title: 'Another writer' }] });
    else f.socket.emit('close');
    await expect(f.pending).rejects.toMatchObject({ code: 'DASHBOARD_SAVE_UNCONFIRMED' });
    expect(f.socket.sent.filter((frame) => frame.type === 'lovelace/config/save')).toHaveLength(1);
  }
});
it('stops before authentication if approval is revoked and aborts in-flight sockets', async () => {
  const f = exchange();
  f.check.mockImplementation(() => {
    throw new Error('revoked');
  });
  f.socket.receive({ type: 'auth_required' });
  await expect(f.pending).rejects.toMatchObject({ code: 'DASHBOARD_REQUEST_FAILED' });
  expect(f.socket.sent).toEqual([]);
  const active = exchange();
  authenticate(active.socket);
  active.controller.abort();
  await expect(active.pending).rejects.toThrow();
  expect(active.socket.terminate).toHaveBeenCalledOnce();
});
it('rejects invalid commands, payloads, oversized and binary messages, wrong ids and authentication failures', async () => {
  for (const request of [
    { operation: 'auth' },
    { operation: 'save', config: '{}' },
    { operation: 'read', config: '{}' },
    { operation: 'list', urlPath: 'x' },
    { operation: 'read', urlPath: '../other' },
    { operation: 'save', config: '[]', expectedConfigHash: 'a'.repeat(64) },
  ]) {
    expect(() => validateDashboardRequest(request)).toThrow();
  }
  const deep = '['.repeat(70) + '0' + ']'.repeat(70);
  expect(() =>
    validateDashboardRequest({
      operation: 'save',
      config: '{"deep":' + deep + '}',
      expectedConfigHash: 'a'.repeat(64),
    }),
  ).toThrow();
  for (const kind of ['auth', 'binary', 'wrong-id', 'error']) {
    const f = exchange();
    if (kind === 'auth') {
      f.socket.receive({ type: 'auth_required' });
      f.socket.receive({ type: 'auth_invalid', message: 'fixture-private-token' });
    } else {
      authenticate(f.socket);
      if (kind === 'binary') f.socket.receive({}, true);
      else
        f.socket.receive({
          type: 'result',
          id: kind === 'wrong-id' ? 9 : 1,
          success: kind !== 'error',
          result: {},
        });
    }
    await expect(f.pending).rejects.toMatchObject({ code: 'DASHBOARD_REQUEST_FAILED' });
  }
});
it('rejects unsafe literal destinations and cancelled operations before opening a socket', () => {
  const create = vi.fn();
  const input = {
    url: new URL('wss://127.0.0.1/api/websocket'),
    token: 'fixture',
    allowPrivateNetwork: true,
    request: { operation: 'read' as const },
    check: () => {},
  };
  expect(() => dashboardExchange(input, new AbortController().signal, create)).toThrow();
  const aborted = new AbortController();
  aborted.abort();
  expect(() =>
    dashboardExchange(
      { ...input, url: new URL('wss://ha.example.com/api/websocket') },
      aborted.signal,
      create,
    ),
  ).toThrow();
  expect(create).not.toHaveBeenCalled();
});

const stores: CredentialConnectionStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.useRealTimers();
});
function serviceFixture() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const vault = {
    save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
    link: vi.fn(),
    read: vi.fn(async () => 'fixture-private-token'),
    remove: vi.fn(),
  };
  const send = vi.fn<DashboardSender>(async () => '{}');
  const service = new CredentialConnections(store, vault, vi.fn(), send);
  const connection = {
    label: 'Home Assistant',
    serviceTemplate: 'home-assistant',
    endpoint: 'https://ha.example.com',
    auth: { kind: 'bearer' },
    paths: ['/api/'],
    methods: ['GET'],
    allowPrivateNetwork: false,
  };
  return { service, store, vault, send, connection };
}
it('keeps dashboard access disabled by default and requires an exact session grant before secret resolution', async () => {
  const f = serviceFixture();
  const c = await f.service.create(f.connection, { secret: 'fixture-private-token' });
  expect(c.homeAssistantDashboards).toBe('disabled');
  f.service.grant('a', c.id, 1);
  await expect(
    f.service.dashboardRequest('a', c.id, { operation: 'read' }, new AbortController().signal),
  ).rejects.toThrow();
  const updated = f.service.updateDashboardAccess(c.id, 1, 'read-write');
  expect(updated.revision).toBe(2);
  expect(f.service.sessions(c.id)).toEqual([]);
  await expect(
    f.service.dashboardRequest('a', c.id, { operation: 'read' }, new AbortController().signal),
  ).rejects.toThrow('Session approval');
  expect(f.vault.read).not.toHaveBeenCalled();
  f.service.grant('a', c.id, 2);
  await f.service.dashboardRequest('a', c.id, { operation: 'read' }, new AbortController().signal);
  expect(f.send).toHaveBeenCalledWith(
    expect.objectContaining({
      url: new URL('wss://ha.example.com/api/websocket'),
      token: 'fixture-private-token',
    }),
    expect.any(AbortSignal),
  );
});
it('redacts echoed credentials in WebSocket results, including escaped JSON keys and values', async () => {
  const f = serviceFixture();
  const c = await f.service.create(
    { ...f.connection, homeAssistantDashboards: 'read' },
    { secret: 'fixture-private-token' },
  );
  f.service.grant('a', c.id, 1);
  f.send.mockResolvedValue(
    '{"\\u0066ixture-private-token":"Bearer fixture-private-token","safe":"' +
      encodeURIComponent('fixture-private-token') +
      '"}',
  );
  expect(
    await f.service.dashboardRequest(
      'a',
      c.id,
      { operation: 'read' },
      new AbortController().signal,
    ),
  ).not.toContain('fixture-private-token');
});
it('rejects non-bearer or out-of-scope connections, stale access updates and saves through read-only scope', async () => {
  const f = serviceFixture();
  await expect(
    f.service.create(
      {
        ...f.connection,
        auth: { kind: 'basic', username: 'user' },
        homeAssistantDashboards: 'read',
      },
      { secret: 'fixture-private-token' },
    ),
  ).rejects.toThrow();
  await expect(
    f.service.create(
      { ...f.connection, paths: ['/api/states'], homeAssistantDashboards: 'read' },
      { secret: 'fixture-private-token' },
    ),
  ).rejects.toThrow();
  const c = await f.service.create(
    { ...f.connection, homeAssistantDashboards: 'read' },
    { secret: 'fixture-private-token' },
  );
  f.service.grant('a', c.id, 1);
  expect(() => f.service.updateDashboardAccess(c.id, 2, 'read-write')).toThrow(
    'Connection changed',
  );
  await expect(
    f.service.dashboardRequest(
      'a',
      c.id,
      { operation: 'save', config: '{}', expectedConfigHash: 'a'.repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.vault.read).not.toHaveBeenCalled();
});
it('cancels active dashboard calls when access is changed and rejects concurrent writes to the same dashboard', async () => {
  const f = serviceFixture();
  const c = await f.service.create(
    { ...f.connection, homeAssistantDashboards: 'read-write' },
    { secret: 'fixture-private-token' },
  );
  f.service.grant('a', c.id, 1);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.send.mockImplementation(
    (_input, signal) =>
      new Promise<string>((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  );
  const request = { operation: 'save', config: '{}', expectedConfigHash: 'a'.repeat(64) };
  const pending = f.service.dashboardRequest('a', c.id, request, new AbortController().signal);
  await ready;
  await expect(
    f.service.dashboardRequest('a', c.id, request, new AbortController().signal),
  ).rejects.toThrow('already running');
  f.service.updateDashboardAccess(c.id, 1, 'read');
  await expect(pending).rejects.toThrow();
  expect(f.service.sessions(c.id)).toEqual([]);
});

it.each(['grant', 'revision', 'policy', 'abort'] as const)(
  'preserves an unconfirmed save when %s changes after dispatch',
  async (change) => {
    const f = serviceFixture();
    const c = await f.service.create(
      { ...f.connection, homeAssistantDashboards: 'read-write' },
      { secret: 'fixture-private-token' },
    );
    f.service.grant('a', c.id, 1);
    const controller = new AbortController();
    let allowed = true;
    f.send.mockImplementation(async () => {
      if (change === 'grant') f.store.revokeAll(c.id);
      if (change === 'revision') f.service.updateDashboardAccess(c.id, 1, 'read');
      if (change === 'policy') allowed = false;
      if (change === 'abort') controller.abort();
      return '{"operation":"save","verified":true}';
    });
    await expect(
      f.service.dashboardRequest(
        'a',
        c.id,
        { operation: 'save', config: '{}', expectedConfigHash: 'a'.repeat(64) },
        controller.signal,
        () => allowed,
      ),
    ).rejects.toMatchObject({ code: 'DASHBOARD_SAVE_UNCONFIRMED' });
    expect(f.send).toHaveBeenCalledOnce();
  },
);

it('bounds response frames and expires stalled authentication without leaking raw failures', async () => {
  const oversized = exchange();
  authenticate(oversized.socket);
  oversized.socket.result({ views: [], padding: 'x'.repeat(256 * 1024) });
  await expect(oversized.pending).rejects.toMatchObject({ code: 'DASHBOARD_REQUEST_FAILED' });
  vi.useFakeTimers();
  const stalled = exchange();
  const failure = expect(stalled.pending).rejects.toMatchObject({
    code: 'DASHBOARD_REQUEST_FAILED',
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
  expect(stalled.socket.sent).toEqual([]);
  expect(stalled.socket.terminate).toHaveBeenCalledOnce();
});

it('refuses to save a credential-bearing baseline even when its original hash is supplied', async () => {
  for (const credential of [
    'fixture-private-token',
    'Bearer fixture-private-token',
    'fixture-private-\\u0074oken',
  ]) {
    const config = JSON.parse('{"views":[],"url":"' + credential + '"}');
    const f = exchange({
      operation: 'save',
      config: JSON.stringify({ views: [], url: '[redacted]' }),
      expectedConfigHash: dashboardConfigHash(config),
    });
    authenticate(f.socket);
    f.socket.result(config);
    await expect(f.pending).rejects.toMatchObject({ code: 'DASHBOARD_REDACTED' });
    expect(f.socket.sent.some((frame) => frame.type === 'lovelace/config/save')).toBe(false);
  }
});
it('returns a redacted read as non-editable without the unredacted configuration hash', async () => {
  const f = serviceFixture();
  const c = await f.service.create(
    { ...f.connection, homeAssistantDashboards: 'read-write' },
    { secret: 'fixture-private-token' },
  );
  f.service.grant('a', c.id, 1);
  const config = { views: [], secret: 'fixture-private-token' };
  f.send.mockResolvedValue(
    JSON.stringify({ operation: 'read', config, configHash: dashboardConfigHash(config) }),
  );
  const result = JSON.parse(
    await f.service.dashboardRequest(
      'a',
      c.id,
      { operation: 'read' },
      new AbortController().signal,
    ),
  );
  expect(result).toMatchObject({
    redacted: true,
    writable: false,
    configHash: null,
    config: { secret: '[redacted]' },
  });
});

it('rejects dashboard numbers that would change during JSON serialization', () => {
  for (const config of ['{"views":[],"number":1e400}', '{"views":[],"number":9007199254740993}']) {
    expect(() =>
      validateDashboardRequest({ operation: 'save', config, expectedConfigHash: 'a'.repeat(64) }),
    ).toThrow('safely representable');
  }
});
