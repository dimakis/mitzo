import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createTerminalRouter } from '../terminal-router.js';
function setup(enabled = true) {
  const host = {
    list: vi.fn(() => [
      { id: 'plan-a', label: 'Personal', state: 'connected', email: 'user@example.test' },
    ]),
    pending: vi.fn(() => ({ id: 'attempt-a', state: 'pending' })),
    start: vi.fn(async () => ({ id: 'attempt-a', state: 'pending' })),
    status: vi.fn(() => ({ id: 'attempt-a', state: 'connected' })),
    cancel: vi.fn(async () => {}),
    disconnect: vi.fn(async () => ({ revoked: true })),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/terminals',
    createTerminalRouter({
      service: { bindOwner: () => {} } as never,
      authorize: (req, res, next) => {
        if (req.header('authorization') !== 'Bearer operator') {
          res.sendStatus(403);
          return;
        }
        res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
        next();
      },
      planAdvisers: () => (enabled ? (host as never) : null),
    }),
  );
  return { app, host };
}
it('exposes sign-in metadata only to the operator and keeps the disabled host closed', async () => {
  const { app, host } = setup();
  await request(app).get('/api/terminals/subscriptions').expect(403);
  expect(host.list).not.toHaveBeenCalled();
  const response = await request(app)
    .get('/api/terminals/subscriptions')
    .set('authorization', 'Bearer operator')
    .expect(200);
  expect(response.body.enabled).toBe(true);
  expect(response.body.accounts[0].label).toBe('Personal');
  expect(response.body.pendingAttempt).toEqual({ id: 'attempt-a', state: 'pending' });
  expect(host.pending).toHaveBeenCalledWith('operator');
  const disabled = setup(false);
  expect(
    (
      await request(disabled.app)
        .get('/api/terminals/subscriptions')
        .set('authorization', 'Bearer operator')
    ).body,
  ).toEqual({ enabled: false, accounts: [], pendingAttempt: null });
  await request(disabled.app)
    .post('/api/terminals/subscriptions/start')
    .set('authorization', 'Bearer operator')
    .send({ label: 'Personal' })
    .expect(503);
});
it('uses deliberate same-origin sign-in with no caller-supplied credentials, URLs or host paths', async () => {
  const { app, host } = setup();
  await request(app)
    .post('/api/terminals/subscriptions/start')
    .set('authorization', 'Bearer operator')
    .set('origin', 'https://untrusted.test')
    .send({ label: 'Personal' })
    .expect(403);
  await request(app)
    .post('/api/terminals/subscriptions/start')
    .set('authorization', 'Bearer operator')
    .send({ label: 'Personal', accessToken: 'private' })
    .expect(400);
  expect(host.start).not.toHaveBeenCalled();
  const result = await request(app)
    .post('/api/terminals/subscriptions/start')
    .set('authorization', 'Bearer operator')
    .send({ label: 'Personal' })
    .expect(202);
  expect(result.body).toEqual({ id: 'attempt-a', state: 'pending' });
  expect(host.start).toHaveBeenCalledWith('operator', expect.any(Number), 'Personal', undefined);
  await request(app)
    .get('/api/terminals/subscriptions/attempts/attempt-a')
    .set('authorization', 'Bearer operator')
    .expect(200);
  expect(host.status).toHaveBeenCalledWith('operator', 'attempt-a');
});
it('requires explicit cancel/disconnect and sanitizes failures', async () => {
  const { app, host } = setup();
  await request(app)
    .post('/api/terminals/subscriptions/attempts/attempt-a/cancel')
    .set('authorization', 'Bearer operator')
    .send({})
    .expect(200);
  expect(host.cancel).toHaveBeenCalledWith('operator', 'attempt-a');
  await request(app)
    .post('/api/terminals/subscriptions/plan-a/disconnect')
    .set('authorization', 'Bearer operator')
    .send({})
    .expect(200);
  expect(host.disconnect).toHaveBeenCalledWith('plan-a', expect.any(AbortSignal));
  host.start.mockRejectedValueOnce(Error('private-secret'));
  const result = await request(app)
    .post('/api/terminals/subscriptions/start')
    .set('authorization', 'Bearer operator')
    .send({ label: 'Personal' })
    .expect(409);
  expect(JSON.stringify(result.body)).not.toContain('private-secret');
});
