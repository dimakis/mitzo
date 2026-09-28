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
it('requires recent authorization before forwarding exact source seal recovery', async () => {
  const invoke = vi.fn(async () => ({ status: 200, body: { seal: { state: 'complete' } } }));
  const app = express();
  app.use(express.json(), authMiddleware);
  app.post('/reauthorize', ...recentAppReauthorizationHandlers());
  app.use(createCustodianProxy({ request: invoke, invalidate: vi.fn() }));
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const path = '/api/sessions/s1/symposium/source/seal/recover';
  const body = { expectedRevision: 4, expectedGeneration: 'volume-gen', operationId: 'import-1' };
  expect(
    (await request(app).post(path).set('Authorization', `Bearer ${token}`).send(body)).status,
  ).toBe(403);
  expect(invoke).not.toHaveBeenCalled();
  const reauth = await request(app)
    .post('/reauthorize')
    .set('Authorization', `Bearer ${token}`)
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  expect(reauth.status).toBe(200);
  expect(
    (
      await request(app)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', reauth.body.csrf)
        .send(body)
    ).status,
  ).toBe(200);
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'source.sealRecover',
      sessionId: 's1',
      body,
      authorization: expect.objectContaining({ recentUntil: reauth.body.expiresAt }),
    }),
    undefined,
    expect.any(AbortSignal),
  );
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
it('invalidates a retained parent grant when logout follows an already completed response', async () => {
  const { revokeOperatorSessions } = await import('../auth.js');
  const { dispatchCustodianHttp } = await import('../symposium-custodian-http.js');
  const parent = express();
  parent.use(authMiddleware);
  parent.get('/api/sessions/s1/symposium', (_req, res) => res.json({ ok: true }));
  const token = (await login(process.env.AUTH_PASSPHRASE!))!,
    auth = (await authenticateToken(token))!;
  const retained = {
    epoch: 1,
    requestId: 'completed',
    operation: 'director.status' as const,
    sessionId: 's1',
    body: {},
    query: {},
    authorization: auth,
  };
  expect((await dispatchCustodianHttp(parent, retained, () => {})).status).toBe(200);
  const notify = vi.fn((id: string) => revokeAuthSession({ id, expiresAt: auth.expiresAt }));
  revokeOperatorSessions([auth], notify);
  expect(notify).toHaveBeenCalledWith(auth.id);
  expect(
    (
      await dispatchCustodianHttp(
        parent,
        { ...retained, epoch: 2, requestId: 'new-epoch' },
        () => {},
      )
    ).status,
  ).toBe(403);
});
it('fences every noncanonical or unsupported protected request before a child safety handler', async () => {
  const local = vi.fn((_req: express.Request, res: express.Response) => res.json({ local: true }));
  const invoke = vi.fn(async () => ({ status: 200, body: { remote: true } }));
  const app = express();
  app.use(express.json());
  app.use(createCustodianProxy({ request: invoke, invalidate() {} }));
  app.all('/api/sessions/:id/symposium/*', local);
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  for (const path of [
    '/api/sessions/session/Symposium/deliveries/d/cancel',
    '/api/sessions/%73ession/symposium/deliveries/d/cancel',
    '/api/sessions/session/symposium/unknown',
  ])
    expect(
      (
        await request(app)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ idempotencyKey: 'unchanged', reason: 'test' })
      ).status,
    ).toBe(400);
  expect(
    (
      await request(app)
        .head('/api/sessions/session/symposium/status')
        .set('Authorization', `Bearer ${token}`)
    ).status,
  ).toBe(400);
  expect(local).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
