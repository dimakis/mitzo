import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';
import { createCredentialConnectionsRouter } from '../credential-connections-router.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));
const stores: CredentialConnectionStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const vault = {
    save: vi.fn(async () => ({ service: 'mitzo.connection.id', account: 'credential' })),
    link: vi.fn(),
    read: vi.fn(async () => 'private-token'),
    remove: vi.fn(),
  };
  const service = new CredentialConnections(
    store,
    vault,
    vi.fn(async () => ({ status: 200, body: 'private-token' })),
  );
  const app = express();
  app.use((req, res, next) => {
    if (req.header('x-browser') === 'yes')
      res.locals.authSession = {
        id: req.header('x-session') ?? 'browser-a',
        expiresAt: Date.now() + 60_000,
      };
    next();
  });
  app.use('/api/credential-connections', createCredentialConnectionsRouter(service));
  return { app, service, vault };
}
const connection = {
  label: 'HA',
  endpoint: 'https://ha.example.com',
  auth: { kind: 'bearer' },
  paths: ['/api/'],
  methods: ['GET'],
  allowPrivateNetwork: false,
};
it('requires a browser identity and recent browser-bound CSRF reauthorization', async () => {
  const { app, vault } = setup();
  expect((await request(app).get('/api/credential-connections')).status).toBe(401);
  expect(
    (
      await request(app)
        .post('/api/credential-connections')
        .set('x-browser', 'yes')
        .send({ ...connection, secret: 'private-token' })
    ).status,
  ).toBe(403);
  const auth = await request(app)
    .post('/api/credential-connections/reauthorize')
    .set('x-browser', 'yes')
    .send({ passphrase: 'correct' });
  expect(auth.status).toBe(200);
  expect(
    (
      await request(app)
        .post('/api/credential-connections')
        .set('x-browser', 'yes')
        .set('x-session', 'browser-b')
        .set('x-csrf-token', auth.body.csrf)
        .send({ connection, secret: 'private-token' })
    ).status,
  ).toBe(403);
  expect(vault.save).not.toHaveBeenCalled();
  const result = await request(app)
    .post('/api/credential-connections')
    .set('x-browser', 'yes')
    .set('x-csrf-token', auth.body.csrf)
    .send({ connection, secret: 'private-token' });
  expect(result.status).toBe(201);
  expect(JSON.stringify(result.body)).not.toMatch(
    /private-token|credentialRef|mitzo.connection.id/,
  );
});
it('rejects untrusted origins and malformed secret input without echoing it', async () => {
  const { app } = setup();
  expect(
    (
      await request(app)
        .post('/api/credential-connections/reauthorize')
        .set('x-browser', 'yes')
        .set('Origin', 'https://evil.example')
        .send({ passphrase: 'correct' })
    ).status,
  ).toBe(403);
  const result = await request(app)
    .post('/api/credential-connections')
    .set('x-browser', 'yes')
    .set('Content-Type', 'application/json')
    .send('{"secret":"private-token"');
  expect(result.status).toBe(400);
  expect(JSON.stringify(result.body)).not.toContain('private-token');
});
it('tests via a temporary administrative grant without authorizing any agent session', async () => {
  const { app, service } = setup();
  const c = await service.create(connection, { secret: 'private-token' });
  const auth = await request(app)
    .post('/api/credential-connections/reauthorize')
    .set('x-browser', 'yes')
    .send({ passphrase: 'correct' });
  const result = await request(app)
    .post(`/api/credential-connections/${c.id}/test`)
    .set('x-browser', 'yes')
    .set('x-csrf-token', auth.body.csrf)
    .send({ revision: c.revision, path: '/api/' });
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.body)).not.toContain('private-token');
  expect(service.catalog('agent-a')[0].access).toBe('approval_required');
});

it('reauthorizes dashboard scope changes, revokes old grants, and rejects stale or invalid changes', async () => {
  const { app, service, vault } = setup();
  const c = await service.create(
    { ...connection, serviceTemplate: 'home-assistant' },
    { secret: 'private-token' },
  );
  service.grant('chat-a', c.id, 1);
  const route = `/api/credential-connections/${c.id}/dashboard-access`;
  expect(
    (
      await request(app)
        .post(route)
        .set('x-browser', 'yes')
        .send({ revision: 1, access: 'read-write' })
    ).status,
  ).toBe(403);
  const auth = await request(app)
    .post('/api/credential-connections/reauthorize')
    .set('x-browser', 'yes')
    .send({ passphrase: 'correct' });
  const send = (body: Record<string, unknown>) =>
    request(app).post(route).set('x-browser', 'yes').set('x-csrf-token', auth.body.csrf).send(body);
  const result = await send({ revision: 1, access: 'read-write' });
  expect(result.status).toBe(200);
  expect(result.body.connection).toMatchObject({
    revision: 2,
    homeAssistantDashboards: 'read-write',
  });
  expect(service.sessions(c.id)).toEqual([]);
  expect(vault.read).not.toHaveBeenCalled();
  expect((await send({ revision: 1, access: 'disabled' })).status).toBe(409);
  expect((await send({ revision: 2, access: 'all-commands' })).status).toBe(400);
});

it('rejects dashboard scope expansion for a custom API even after browser reauthorization', async () => {
  const { app, service, vault } = setup();
  const c = await service.create(
    { ...connection, serviceTemplate: 'custom' },
    { secret: 'private-token' },
  );
  service.grant('chat-a', c.id, c.revision);
  const auth = await request(app)
    .post('/api/credential-connections/reauthorize')
    .set('x-browser', 'yes')
    .send({ passphrase: 'correct' });
  const result = await request(app)
    .post(`/api/credential-connections/${c.id}/dashboard-access`)
    .set('x-browser', 'yes')
    .set('x-csrf-token', auth.body.csrf)
    .send({ revision: c.revision, access: 'read' });
  expect(result.status).toBe(422);
  expect(service.connection(c.id).revision).toBe(c.revision);
  expect(service.catalog('chat-a')[0].access).toBe('approved');
  expect(vault.read).not.toHaveBeenCalled();
});

it('updates generic WebSocket setup only through recent browser authorization at the exact revision', async () => {
  const { app, service, vault } = setup();
  const c = await service.create(connection, { secret: 'private-token' });
  service.grant('chat-a', c.id, 1);
  const route = `/api/credential-connections/${c.id}/websocket`;
  const websocket = { path: '/api/socket', authentication: { kind: 'headers' } };
  expect(
    (await request(app).post(route).set('x-browser', 'yes').send({ revision: 1, websocket }))
      .status,
  ).toBe(403);
  const auth = await request(app)
    .post('/api/credential-connections/reauthorize')
    .set('x-browser', 'yes')
    .send({ passphrase: 'correct' });
  const send = (body: Record<string, unknown>) =>
    request(app).post(route).set('x-browser', 'yes').set('x-csrf-token', auth.body.csrf).send(body);
  const result = await send({ revision: 1, websocket });
  expect(result.status).toBe(200);
  expect(result.body.connection).toMatchObject({ revision: 2, websocket });
  expect(service.sessions(c.id)).toEqual([]);
  expect(vault.read).not.toHaveBeenCalled();
  expect((await send({ revision: 1, websocket: null })).status).toBe(409);
  expect((await send({ revision: 2, websocket: { ...websocket, path: '/outside' } })).status).toBe(
    422,
  );
  expect((await send({ revision: 2, websocket: { ...websocket, token: 'bad' } })).status).toBe(400);
  expect((await send({ revision: 2, websocket: null })).body.connection.websocket).toBeNull();
});
