import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  CredentialConnections,
  CredentialConnectionStore,
  type AuthenticatedRequest,
} from '../credential-connections.js';
import { createCredentialConnectionTools } from '../credential-connection-tools.js';
import { createCredentialConnectionsRouter } from '../credential-connections-router.js';

vi.mock('../auth.js', () => ({
  verifyPassphrase: (value: string) => value === 'fixture-passphrase',
}));
const stores: CredentialConnectionStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

it('takes an unconnected chat through private enrollment and returns to separately approved service use', async () => {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const credential = 'fixture-private-key';
  const vault = {
    save: vi.fn(async () => ({ service: 'fixture-vault', account: 'fixture-account' })),
    read: vi.fn(async () => credential),
    link: vi.fn(),
    remove: vi.fn(async () => {}),
  };
  const send = vi.fn(async (input: AuthenticatedRequest) => ({
    status: input.headers.Authorization ? 200 : 401,
    body: input.headers.Authorization
      ? input.url.pathname.endsWith('/api/')
        ? '{"message":"API running."}'
        : '{"entity_id":"switch.oven","state":"off"}'
      : 'Unauthorized',
  }));
  const service = new CredentialConnections(store, vault, send);
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }));
  const tools = createCredentialConnectionTools(service, 'origin-chat', approve, () => true);
  const signal = new AbortController().signal;
  const prepared = await tools.execute(
    'PrepareConnectionSetup',
    {
      profile: 'home-assistant',
      endpoint: 'https://ha.example.test',
      access: 'read-write',
    },
    signal,
  );
  expect(prepared?.isError).toBe(false);
  const { setup } = JSON.parse(prepared!.content);
  expect(setup.setupUrl).toBe(`/connections/setup/${setup.id}`);
  expect(vault.save).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  const onReady = vi.fn(async () => true);
  const app = express();
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'fixture-browser', expiresAt: Date.now() + 60_000 };
    next();
  });
  app.use('/api/credential-connections', createCredentialConnectionsRouter(service, { onReady }));
  const authorization = await request(app)
    .post('/api/credential-connections/reauthorize')
    .send({ passphrase: 'fixture-passphrase' });
  expect(authorization.status).toBe(200);
  const completed = await request(app)
    .post(`/api/credential-connections/setups/${setup.id}/complete`)
    .set('x-csrf-token', authorization.body.csrf)
    .send({ revision: setup.revision, secret: credential });
  expect(completed.status).toBe(200);
  expect(completed.body.setup.status).toBe('ready');
  expect(onReady).toHaveBeenCalledOnce();
  expect(JSON.stringify(completed.body)).not.toContain(credential);
  expect(service.catalog('origin-chat')[0].access).toBe('approval_required');

  const ready = await tools.execute('GetConnectionSetup', { setupId: setup.id }, signal);
  expect(JSON.parse(ready!.content).setup.status).toBe('ready');
  const foreign = createCredentialConnectionTools(service, 'other-chat', approve, () => true);
  const rejected = await foreign.execute('GetConnectionSetup', { setupId: setup.id }, signal);
  expect(rejected?.isError).toBe(true);

  const result = await tools.execute(
    'ConnectionRequest',
    {
      connectionId: completed.body.setup.connectionId,
      method: 'GET',
      path: '/api/states/switch.oven',
    },
    signal,
  );
  expect(result?.isError).toBe(false);
  expect(result?.content).toContain('switch.oven');
  expect(approve).toHaveBeenCalledOnce();
  expect(service.catalog('other-chat')[0].access).toBe('approval_required');
  expect(JSON.stringify([prepared, ready, rejected, result])).not.toContain(credential);
});
