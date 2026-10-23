import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createCredentialConnectionsRouter } from '../credential-connections-router.js';
vi.mock('../auth.js', () => ({
  verifyPassphrase: (value: string) => value === 'correct',
  isAuthSessionCurrent: () => true,
}));
import type { CredentialConnections } from '../credential-connections.js';
it('serves only secret-free relay metadata to authenticated browser sessions', async () => {
  const relay = { browserStatus: vi.fn(() => ({ id: 'relay', status: 'pending' })) };
  const service = { relay } as unknown as CredentialConnections;
  const app = express();
  app.use((_req, res, next) => {
    if (_req.header('x-browser')) res.locals.authSession = { expiresAt: Date.now() + 10000 };
    next();
  });
  app.use('/api', createCredentialConnectionsRouter(service));
  expect((await request(app).get('/api/relays/relay')).status).toBe(401);
  const result = await request(app).get('/api/relays/relay').set('x-browser', 'yes');
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ relay: { id: 'relay', status: 'pending' } });
  expect(result.headers['cache-control']).toBe('no-store');
  expect(
    (
      await request(app)
        .post('/api/relays/relay/complete')
        .set('x-browser', 'yes')
        .send({ secret: 'bad', revision: 1 })
    ).status,
  ).toBe(403);
});

it('rechecks the browser capability after Gateway storage before publishing readiness', async () => {
  const { CredentialConnectionStore, CredentialConnections } =
    await import('../credential-connections.js');
  const { SecretRelays } = await import('../secret-relay.js');
  const store = new CredentialConnectionStore(':memory:');
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ref = {
    gateway: 'g',
    workspace: 'w',
    name: 'mitzo-secret-11111111-1111-4111-8111-111111111111',
    providerId: 'id',
    version: '1',
    profileVersion: '1',
  };
  const service = new CredentialConnections(
    store,
    { save: vi.fn(), read: vi.fn(), link: vi.fn(), remove: vi.fn() },
    vi.fn(),
  );
  service.relay = new SecretRelays(
    store,
    {
      save: async () => {
        started();
        await blocked;
        return ref;
      },
      read: vi.fn(),
    },
    vi.fn(),
    vi.fn(),
    true,
  );
  const draft = service.relay.prepare('chat', {
    label: 'MQTT',
    targets: [
      {
        lanEndpoint: 'http://192.168.1.115',
        path: '/settings',
        method: 'POST',
        encoding: 'form',
        body: 'password=',
        fields: ['password'],
      },
    ],
  });
  const onRelayReady = vi.fn(async () => true);
  const app = express();
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'relay-browser', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/api',
    createCredentialConnectionsRouter(service, { canCompleteRelay: () => true, onRelayReady }),
  );
  try {
    const auth = await request(app).post('/api/reauthorize').send({ passphrase: 'correct' });
    const operation = request(app)
      .post(`/api/relays/${draft.id}/complete`)
      .set('x-csrf-token', auth.body.csrf)
      .send({ revision: 1, secret: 'private-fixture' })
      .then((r) => r);
    await entered;
    await request(app).post('/api/reauthorize').send({ passphrase: 'correct' });
    release();
    const result = await operation;
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).not.toContain('private-fixture');
    expect(service.relay.browserStatus(draft.id).status).toBe('unconfirmed');
    expect(onRelayReady).not.toHaveBeenCalled();
  } finally {
    release();
    store.close();
  }
});
it('captures MFA only through recent browser authorization and wakes the original chat without dispatching code', async () => {
  const draft = { id: 'relay', sessionId: 'chat', status: 'ready', revision: 4 };
  const ready = { ...draft, revision: 5, continuation: 1, delivery: 'pending' };
  const relay = {
    browserStatus: vi.fn(() => draft),
    provideBrowserCode: vi.fn(() => ready),
    markDelivered: vi.fn(),
  };
  const onRelayReady = vi.fn(async () => true);
  let available = true;
  const app = express();
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'mfa-browser', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/api',
    createCredentialConnectionsRouter({ relay } as unknown as CredentialConnections, {
      canCompleteRelay: () => available,
      onRelayReady,
    }),
  );
  let auth = await request(app).post('/api/reauthorize').send({ passphrase: 'correct' });
  const post = (body: unknown, csrf = auth.body.csrf) =>
    request(app).post('/api/relays/relay/code').set('x-csrf-token', csrf).send(body);
  const body = { revision: 4, targetIndex: 0, code: '123456' };
  expect((await post(body, 'invalid')).status).toBe(403);
  auth = await request(app).post('/api/reauthorize').send({ passphrase: 'correct' });
  available = false;
  expect((await post(body)).status).toBe(409);
  expect(relay.provideBrowserCode).not.toHaveBeenCalled();
  available = true;
  expect((await post({ ...body, code: '123' })).status).toBe(400);
  expect((await post(body)).status).toBe(200);
  expect(relay.provideBrowserCode).toHaveBeenCalledWith(
    'relay',
    4,
    0,
    '123456',
    expect.any(Function),
  );
  expect(onRelayReady).toHaveBeenCalledWith(ready);
});
