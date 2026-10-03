import { expect, it, vi } from 'vitest';
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Express, Request, Response } from 'express';
import { login, authenticateToken, authMiddleware, operatorAuthMiddleware } from '../auth.js';
import { createCustodianProxy } from '../symposium-custodian-proxy.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
import { SymposiumCustodianController } from '../symposium-custodian-controller.js';
import type { CustodianRequest } from '../symposium-custodian-protocol.js';

async function mockHttp(app: Express, method: string, path: string, token?: string, body = {}) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path;
  const json = JSON.stringify(body);
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  req.push(json);
  req.push(null);
  const res = new ServerResponse(req);
  try {
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      res.end = ((chunk?: unknown) => {
        resolve({ status: res.statusCode, body: JSON.parse(String(chunk)) });
        return res;
      }) as typeof res.end;
      app(req as Request, res as Response, reject);
    });
  } finally {
    req.destroy();
  }
}

it('forwards the exact receipt lookup through the real controller and retained HTTP auth with session and operator scope', async () => {
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const authorization = (await authenticateToken(token))!;
  const key = 'original-operation-revise';
  const retained = {
    sessionId: 'session-1',
    idempotencyKey: key,
    actor: `operator:${authorization.id}`,
    config: { revision: 3 },
  };
  const lookup = vi.fn((sessionId: string, resourceId: string) =>
    sessionId === retained.sessionId && resourceId === key ? retained : null,
  );
  const owner = express();
  owner.use(express.json(), authMiddleware, operatorAuthMiddleware);
  owner.get('/api/sessions/:id/symposium/configuration-operations/:key', (req, res) => {
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    expect(req.body).toEqual({});
    const receipt = lookup(req.params.id, req.params.key);
    if (receipt && receipt.actor !== `operator:${res.locals.authSession.id}`) {
      res.status(403).json({ error: 'Configuration operation belongs to another operator' });
      return;
    }
    res.json({ receipt });
  });
  const nativeEffects = {
    pause: vi.fn(),
    drain: vi.fn(async () => {}),
    resume: vi.fn(),
    invalidate: vi.fn(),
  };
  const dispatch = vi.fn((input: CustodianRequest, assertCurrent: () => void) =>
    dispatchCustodianHttp(owner, input, assertCurrent),
  );
  const attachment = new SymposiumCustodianController({ ...nativeEffects, dispatch }).attach();
  const invoke = vi.fn((input: Omit<CustodianRequest, 'epoch'>) =>
    attachment.request({ ...input, epoch: attachment.epoch }),
  );
  const app = express();
  app.use(express.json(), authMiddleware);
  app.use(createCustodianProxy({ request: invoke, invalidate: (id) => attachment.invalidate(id) }));
  const path = `/api/sessions/session-1/symposium/configuration-operations/${encodeURIComponent(key)}`;
  expect((await mockHttp(app, 'GET', path)).status).toBe(401);
  expect(invoke).not.toHaveBeenCalled();
  const result = await mockHttp(app, 'GET', path, token);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ receipt: retained });
  expect(dispatch.mock.lastCall?.[0]).toMatchObject({
    operation: 'director.configurationOperation',
    sessionId: 'session-1',
    resourceId: key,
    authorization: { id: authorization.id, expiresAt: authorization.expiresAt },
    body: {},
    query: {},
  });
  expect(lookup).toHaveBeenLastCalledWith('session-1', key);
  expect(
    (await mockHttp(app, 'GET', path.replace('session-1', 'other-session'), token)).body,
  ).toEqual({ receipt: null });
  const other = (await login(process.env.AUTH_PASSPHRASE!))!;
  expect((await mockHttp(app, 'GET', path, other)).status).toBe(403);
  const calls = invoke.mock.calls.length;
  for (const forbidden of [
    path + '/extra',
    path.replace(key, 'bad%2Fkey'),
    path.replace(key, 'k'.repeat(201)),
  ])
    expect((await mockHttp(app, 'GET', forbidden, token)).status).toBe(400);
  expect((await mockHttp(app, 'POST', path, token)).status).toBe(400);
  expect((await mockHttp(app, 'GET', path, token, { actor: 'operator:forged' })).status).toBe(400);
  expect(invoke).toHaveBeenCalledTimes(calls);
  expect(nativeEffects.pause).not.toHaveBeenCalled();
  expect(nativeEffects.drain).not.toHaveBeenCalled();
  expect(nativeEffects.invalidate).not.toHaveBeenCalled();
});
