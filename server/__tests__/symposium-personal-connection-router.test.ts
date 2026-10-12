import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';

// No credential files, application singleton, database or provider allocation.
vi.mock('../internal-token.js', () => ({
  isValidInternalToken: (token: unknown) => token === 'fixture-internal-token',
  isValidSignalCallbackToken: () => false,
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));
vi.mock('../app.js', () => {
  throw Error('Personal connection routes must not load app');
});
vi.mock('../chat.js', () => {
  throw Error('Personal connection routes must not load chat');
});
vi.mock('../symposium-owned-host.js', () => {
  throw Error('Personal connection routes must not allocate a host');
});
import { authMiddleware, login, authenticateToken, revokeAuthSession } from '../auth.js';
import {
  createSymposiumPersonalConnectionRouter,
  type SymposiumPersonalConnectionService,
} from '../symposium-personal-connection-router.js';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeTestServer(server);
});
const base = '/api/symposium/personal/connections';
const row = { id: 'personal_test', label: 'Personal', revision: 3, state: 'connected' as const };
const operations = [
  ['get', ''],
  ['post', ''],
  ['post', '/personal_test/disconnect'],
  ['post', '/personal_test/models/refresh'],
  ['post', '/personal_test/models/recover'],
  ['post', '/personal_test/routing-diagnostic'],
] as const;

async function fixture() {
  const service = {
    list: vi.fn(() => [row]),
    create: vi.fn((_label: string) => row),
    disconnect: vi.fn(async (_id: string, _revision: number) => ({ ...row, revision: 4 })),
    discoverModels: vi.fn(async (_id: string, _revision: number, current: () => void) => {
      current();
      return { status: 'complete', inference: false };
    }),
    recoverDiscovery: vi.fn(async (_id: string, _revision: number, current: () => void) => {
      current();
      return { status: 'reconciled', inference: false };
    }),
    diagnoseRouting: vi.fn(async (_id: string, _revision: number, current: () => void) => {
      current();
      return {
        status: 'failed' as const,
        inference: false as const,
        catalogPublication: false as const,
      };
    }),
  } satisfies SymposiumPersonalConnectionService;
  let selected: SymposiumPersonalConnectionService | undefined = service;
  const resolve = vi.fn(() => selected);
  const app = express();
  app.use(express.json(), cookieParser(), authMiddleware);
  app.use(base, createSymposiumPersonalConnectionRouter(resolve));
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const cookie = `cc_auth=${token}`;
  const server = await listenOnLoopback(app);
  servers.push(server);
  return {
    server,
    service,
    resolve,
    cookie,
    token,
    select: (value: typeof selected) => {
      selected = value;
    },
  };
}

it.each(operations)(
  'requires an interactive operator for %s %s before resolving a service',
  async (method, path) => {
    const f = await fixture();
    expect(
      (
        await request(f.server)
          [method](base + path)
          .send({ expectedRevision: 3 })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(f.server)
          [method](base + path)
          .set('x-internal-token', 'fixture-internal-token')
          .send({ expectedRevision: 3 })
      ).status,
    ).toBe(403);
    expect(f.resolve).not.toHaveBeenCalled();
  },
);

it('resolves the current service per request without owning provider or persistence state', async () => {
  const f = await fixture();
  const listed = await request(f.server).get(base).set('Cookie', f.cookie);
  expect(listed.status).toBe(200);
  expect(listed.body).toEqual({ connections: [row] });
  expect(listed.headers['cache-control']).toBe('no-store');
  const replacement = { ...f.service, list: vi.fn(() => []) };
  f.select(replacement);
  expect((await request(f.server).get(base).set('Cookie', f.cookie)).body).toEqual({
    connections: [],
  });
  expect(replacement.list).toHaveBeenCalledOnce();
  expect(f.service.list).toHaveBeenCalledOnce();
});

it.each(operations)('preserves unavailable responses for %s %s', async (method, path) => {
  const f = await fixture();
  f.select(undefined);
  const response = await request(f.server)
    [method](base + path)
    .set('Cookie', f.cookie)
    .send({ expectedRevision: 3 });
  expect(response.status).toBe(503);
  expect(response.headers['cache-control']).toBe('no-store');
  for (const operation of Object.values(f.service)) expect(operation).not.toHaveBeenCalled();
});

it('keeps label validation and creation failures with the existing service', async () => {
  const f = await fixture();
  expect(
    (await request(f.server).post(base).set('Cookie', f.cookie).send({ label: 7 })).status,
  ).toBe(400);
  expect(f.service.create).not.toHaveBeenCalled();
  const created = await request(f.server)
    .post(base)
    .set('Cookie', f.cookie)
    .send({ label: 'Personal' });
  expect(created.status).toBe(201);
  expect(created.body).toEqual(row);
  expect(f.service.create).toHaveBeenCalledWith('Personal');
  f.service.create.mockImplementationOnce(() => {
    throw Error('private storage detail');
  });
  const denied = await request(f.server)
    .post(base)
    .set('Cookie', f.cookie)
    .send({ label: 'Duplicate' });
  expect(denied.status).toBe(400);
  expect(JSON.stringify(denied.body)).not.toContain('private');
});

it.each(['disconnect', 'models/refresh', 'models/recover'])(
  'validates revisions before %s and forwards the exact slot/revision',
  async (action) => {
    const f = await fixture();
    const path = `${base}/personal_test/${action}`;
    for (const expectedRevision of [undefined, '3', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        (await request(f.server).post(path).set('Cookie', f.cookie).send({ expectedRevision }))
          .status,
      ).toBe(400);
    }
    const operation =
      action === 'disconnect'
        ? f.service.disconnect
        : action === 'models/refresh'
          ? f.service.discoverModels
          : f.service.recoverDiscovery;
    expect(operation).not.toHaveBeenCalled();
    const response = await request(f.server)
      .post(path)
      .set('Cookie', f.cookie)
      .send({ expectedRevision: 3 });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(operation.mock.calls[0].slice(0, 2)).toEqual(['personal_test', 3]);
  },
);

it('keeps uncertain disconnect errors private', async () => {
  const f = await fixture();
  f.service.disconnect.mockRejectedValueOnce(Error('private credential'));
  const response = await request(f.server)
    .post(`${base}/personal_test/disconnect`)
    .set('Cookie', f.cookie)
    .send({ expectedRevision: 3 });
  expect(response.status).toBe(409);
  expect(response.body.error).toContain('cleanup is unconfirmed');
  expect(JSON.stringify(response.body)).not.toContain('private');
});

it.each(['refresh', 'recover'])(
  'preserves discovery status, unavailable capability and revocation fences for %s',
  async (action) => {
    const f = await fixture();
    const path = `${base}/personal_test/models/${action}`;
    const operation = action === 'refresh' ? f.service.discoverModels : f.service.recoverDiscovery;
    for (const [status, code] of [
      ['failed', 422],
      ['reconciliation_required', 409],
    ] as const) {
      operation.mockResolvedValueOnce({ status, inference: false });
      const response = await request(f.server)
        .post(path)
        .set('Cookie', f.cookie)
        .send({ expectedRevision: 3 });
      expect(response.status).toBe(code);
      expect(response.body).toEqual({ status, inference: false });
    }
    f.select({
      ...f.service,
      [action === 'refresh' ? 'discoverModels' : 'recoverDiscovery']: undefined,
    });
    expect(
      (await request(f.server).post(path).set('Cookie', f.cookie).send({ expectedRevision: 3 }))
        .status,
    ).toBe(503);
    f.select(f.service);
    const session = (await authenticateToken(f.token))!;
    operation.mockImplementationOnce(async (_id, _revision, current) => {
      current();
      revokeAuthSession(session);
      expect(current).toThrow('Operator session expired');
      return { status: 'complete', inference: false };
    });
    const revoked = await request(f.server)
      .post(path)
      .set('Cookie', f.cookie)
      .send({ expectedRevision: 3 });
    expect(revoked.status).toBe(409);
    expect(revoked.body).not.toHaveProperty('status');
  },
);

it('retains routing diagnostic validation and delegates to its existing owner', async () => {
  const f = await fixture();
  const path = `${base}/personal_test/routing-diagnostic`;
  expect(
    (
      await request(f.server)
        .post(path)
        .set('Cookie', f.cookie)
        .set('Origin', 'https://foreign.invalid')
        .send({ expectedRevision: 3 })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(f.server)
        .post(path)
        .set('Cookie', f.cookie)
        .send({ expectedRevision: 3, providerId: 'caller' })
    ).status,
  ).toBe(400);
  expect(f.service.diagnoseRouting).not.toHaveBeenCalled();
  const response = await request(f.server)
    .post(path)
    .set('Cookie', f.cookie)
    .send({ expectedRevision: 3 });
  expect(response.status).toBe(422);
  expect(response.body).toEqual({ status: 'failed', inference: false, catalogPublication: false });
  expect(f.service.diagnoseRouting).toHaveBeenCalledWith('personal_test', 3, expect.any(Function));
});

it('mounts the focused router in the native service with authentication owned by each matched route', () => {
  const source = readFileSync(
    new URL('../symposium-custodian-service.ts', import.meta.url),
    'utf8',
  );
  expect(source).toMatch(
    /app\.use\(\s*'\/api\/symposium\/personal\/connections',\s*createSymposiumPersonalConnectionRouter/,
  );
  expect(source).not.toContain("app.post('/api/symposium/personal/connections'");
  expect(source).not.toContain("app.get('/api/symposium/personal/connections'");
});

it('pins the extracted connection authority source in the reviewed runtime manifest', () => {
  const sources: Record<string, string> = reviewedHandlerSourceArtifacts;
  const source = readFileSync(
    new URL('../symposium-personal-connection-router.ts', import.meta.url),
    'utf8',
  );
  expect(sources['../symposium-personal-connection-router.ts']).toBe(
    reviewedHandlerSourceFingerprint(source),
  );
});
