import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeTestServer(server);
});
import cookieParser from 'cookie-parser';
import request from 'supertest';
import {
  authMiddleware,
  operatorAuthMiddleware,
  login,
  authenticateToken,
  revokeAuthSession,
} from '../auth.js';
import { INTERNAL_TOKEN } from '../internal-token.js';
import { createPersonalRoutingDiagnosticHandler } from '../symposium-routing-diagnostic-route.js';

const path = '/api/symposium/personal/connections/pro-slot/routing-diagnostic';
async function fixture() {
  const result = {
    status: 'failed' as const,
    inference: false as const,
    catalogPublication: false as const,
  };
  const diagnose = vi.fn(async (_id: string, _revision: number, assertCurrent: () => void) => {
    assertCurrent();
    return result;
  });
  const app = express();
  app.use(express.json(), cookieParser(), authMiddleware);
  app.post(
    '/api/symposium/personal/connections/:id/routing-diagnostic',
    operatorAuthMiddleware,
    createPersonalRoutingDiagnosticHandler(() => diagnose),
  );
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const cookie = `cc_auth=${token}`;
  const server = await listenOnLoopback(app);
  servers.push(server);
  return { app: server, diagnose, cookie, token };
}
it('requires interactive operator authority and rejects strict unknown body/query fields', async () => {
  const { app, diagnose, cookie } = await fixture();
  expect((await request(app).post(path).send({ expectedRevision: 7 })).status).toBe(401);
  expect(
    (
      await request(app)
        .post(path)
        .set('x-internal-token', INTERNAL_TOKEN)
        .send({ expectedRevision: 7 })
    ).status,
  ).toBe(403);
  for (const body of [
    {},
    { expectedRevision: 0 },
    { expectedRevision: '7' },
    { expectedRevision: 7, logLevel: 'trace' },
    { expectedRevision: 7, providerId: 'caller' },
  ])
    expect((await request(app).post(path).set('Cookie', cookie).send(body)).status).toBe(400);
  expect(
    (
      await request(app)
        .post(path + '?target=caller')
        .set('Cookie', cookie)
        .send({ expectedRevision: 7 })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post(path)
        .set('Cookie', cookie)
        .set('Origin', 'https://untrusted.test')
        .send({ expectedRevision: 7 })
    ).status,
  ).toBe(403);
  expect(diagnose).not.toHaveBeenCalled();
  const response = await request(app)
    .post(path)
    .set('Cookie', cookie)
    .send({ expectedRevision: 7 });
  expect(response.status).toBe(422);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({ status: 'failed', inference: false, catalogPublication: false });
  expect(diagnose).toHaveBeenCalledWith('pro-slot', 7, expect.any(Function));
});
it('keeps an absent trusted capability closed without allocation', async () => {
  const { app, cookie } = await fixture();
  const closed = express();
  closed.use(express.json(), cookieParser(), authMiddleware);
  closed.post(
    '/api/symposium/personal/connections/:id/routing-diagnostic',
    operatorAuthMiddleware,
    createPersonalRoutingDiagnosticHandler(() => undefined),
  );
  const server = await listenOnLoopback(closed);
  servers.push(server);
  expect(
    (await request(server).post(path).set('Cookie', cookie).send({ expectedRevision: 7 })).status,
  ).toBe(503);
  expect(app).toBeDefined();
});
it('revokes the initiating operator callback around awaited work and suppresses private errors', async () => {
  const { app, diagnose, cookie, token } = await fixture();
  const session = (await authenticateToken(token))!;
  let revocationObserved = false;
  diagnose.mockImplementationOnce(async (_id, _revision, assertCurrent) => {
    assertCurrent();
    revokeAuthSession(session);
    try {
      assertCurrent();
    } catch {
      revocationObserved = true;
    }
    throw new Error('secret token and raw upstream response');
  });
  const response = await request(app)
    .post(path)
    .set('Cookie', cookie)
    .send({ expectedRevision: 7 });
  expect(response.status).toBe(409);
  expect(JSON.stringify(response.body)).not.toContain('secret');
  expect(revocationObserved).toBe(true);
});

it('ends request authority after a completed response', async () => {
  const { app, diagnose, cookie } = await fixture();
  let retained!: () => void;
  diagnose.mockImplementationOnce(async (_id, _revision, assertCurrent) => {
    retained = assertCurrent;
    assertCurrent();
    return { status: 'failed', inference: false, catalogPublication: false };
  });
  expect(
    (await request(app).post(path).set('Cookie', cookie).send({ expectedRevision: 7 })).status,
  ).toBe(422);
  expect(retained).toThrow('unavailable');
});
