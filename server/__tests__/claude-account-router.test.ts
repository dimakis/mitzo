import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createClaudeAccountRouter } from '../claude-account-router.js';
import type { ClaudeAccountLogin } from '../claude-account-login.js';

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const host = {
    list: vi.fn(() => ({ enabled: true, accounts: [], attempts: [] })),
    start: vi.fn(async () => ({ state: 'pending' })),
    status: vi.fn(() => ({ state: 'pending' })),
    submit: vi.fn(async () => ({ state: 'verifying' })),
    cancel: vi.fn(async () => ({ state: 'cancelled' })),
  };
  const app = express();
  app.use((req, res, next) => {
    if (req.header('x-browser') === 'yes')
      res.locals.authSession = { id: 'browser', expiresAt: Date.now() + 60_000 };
    next();
  });
  app.use(
    '/api/claude-accounts',
    createClaudeAccountRouter(() => host as unknown as ClaudeAccountLogin),
  );
  return { app, host };
}
it('rejects internal/unauthenticated callers, foreign origins, oversized codes and unexpected secret fields', async () => {
  const { app, host } = fixture();
  expect((await request(app).get('/api/claude-accounts')).status).toBe(401);
  expect(
    (
      await request(app)
        .post('/api/claude-accounts/start')
        .set('x-browser', 'yes')
        .set('Origin', 'https://evil.test')
        .send({ requestId: crypto.randomUUID() })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/api/claude-accounts/start')
        .set('x-browser', 'yes')
        .send({ requestId: crypto.randomUUID(), credentialRef: '/chosen/by/browser' })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post(`/api/claude-accounts/${crypto.randomUUID()}/code`)
        .set('x-browser', 'yes')
        .send({ code: 'x'.repeat(9000) })
    ).status,
  ).toBe(413);
  expect(host.start).not.toHaveBeenCalled();
  expect(host.submit).not.toHaveBeenCalled();
});
it('keeps codes on a bounded private POST and returns safe correlated failures', async () => {
  const { app, host } = fixture();
  const id = crypto.randomUUID();
  const started = await request(app)
    .post('/api/claude-accounts/start')
    .set('x-browser', 'yes')
    .send({ requestId: id });
  expect(started.status).toBe(200);
  expect(started.headers['cache-control']).toBe('no-store');
  await request(app)
    .post(`/api/claude-accounts/${id}/code`)
    .set('x-browser', 'yes')
    .send({ code: 'private-code#state' })
    .expect(200);
  expect(host.submit).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'browser' }),
    id,
    'private-code#state',
  );
  host.submit.mockRejectedValueOnce(Error('private-code#state'));
  const failed = await request(app)
    .post(`/api/claude-accounts/${id}/code`)
    .set('x-browser', 'yes')
    .send({ code: 'private-code#state' });
  expect(failed.status).toBe(409);
  expect(failed.body).toMatchObject({
    errorCode: 'CLAUDE_LOGIN_REQUEST_FAILED',
    diagnosticId: expect.any(String),
  });
  expect(JSON.stringify(failed.body)).not.toContain('private-code');
});
