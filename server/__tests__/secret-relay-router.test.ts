import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createCredentialConnectionsRouter } from '../credential-connections-router.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));
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
