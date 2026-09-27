import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { login, authenticateToken, revokeAuthSession } from '../auth.js';
import { createCustodianProxy } from '../symposium-custodian-proxy.js';
import { recentAppReauthorizationHandlers } from '../connections-router.js';
import { authMiddleware } from '../auth.js';
it('forwards only middleware-verified JTI and current recent authorization without credentials', async () => {
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const auth = await authenticateToken(token!);
  const invoke = vi.fn(async (_input: unknown) => ({ status: 200, body: { ok: true } }));
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.post('/reauthorize', ...recentAppReauthorizationHandlers());
  app.use(createCustodianProxy({ request: invoke, invalidate: vi.fn() }));
  const reauth = await request(app)
    .post('/reauthorize')
    .set('Authorization', `Bearer ${token}`)
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  expect(reauth.status).toBe(200);
  const response = await request(app)
    .post('/api/sessions/s1/symposium/source/import')
    .set('Authorization', `Bearer ${token}`)
    .set('X-CSRF-Token', reauth.body.csrf)
    .send({ operationId: 'original' });
  expect(response.status).toBe(200);
  const sent = invoke.mock.calls[0]?.[0];
  expect(sent).toMatchObject({
    operation: 'source.import',
    sessionId: 's1',
    authorization: { id: auth!.id, recentUntil: reauth.body.expiresAt },
  });
  expect(JSON.stringify(sent)).not.toContain(token!);
  expect(JSON.stringify(sent)).not.toContain(process.env.AUTH_PASSPHRASE!);
  expect(JSON.stringify(sent)).not.toContain(reauth.body.csrf);
});
it('does not accept caller actor/proof, invalid JWT, internal credentials, or missing recent authorization', async () => {
  const invoke = vi.fn(async (_input: unknown) => ({ status: 200, body: {} }));
  const app = express();
  app.use(express.json());
  app.use(createCustodianProxy({ request: invoke, invalidate: vi.fn() }));
  const token = await login(process.env.AUTH_PASSPHRASE!);
  expect(
    (
      await request(app)
        .post('/api/sessions/s1/symposium/deliveries')
        .set('Authorization', 'Bearer invalid')
        .send({})
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/api/sessions/s1/symposium/source/import')
        .set('Authorization', `Bearer ${token}`)
        .send({ authorization: { recentUntil: Date.now() + 10000 } })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/api/sessions/s1/symposium/deliveries')
        .set('Authorization', `Bearer ${token}`)
        .send({ actor: 'operator:forged' })
    ).status,
  ).toBe(400);
  expect(invoke).not.toHaveBeenCalled();
});
it('forwards logout invalidation while a semantic request is in flight', async () => {
  const invalidate = vi.fn();
  let complete!: () => void;
  const invoked = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let release!: () => void;
  const invoke = vi.fn(async () => {
    complete();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { status: 200, body: {} };
  });
  const app = express();
  app.use(express.json());
  app.use(createCustodianProxy({ request: invoke, invalidate }));
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const auth = await authenticateToken(token!);
  const pending = request(app)
    .get('/api/sessions/s1/symposium')
    .set('Authorization', `Bearer ${token}`)
    .then((value) => value);
  await invoked;
  revokeAuthSession(auth!);
  expect(invalidate).toHaveBeenCalledWith(auth!.id);
  release();
  await pending;
});
