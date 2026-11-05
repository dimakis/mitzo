import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSessionPromptRouter } from '../session-prompt-router.js';
import type { SessionPromptService } from '../session-prompt-service.js';

vi.mock('../auth.js', () => ({
  isAuthSessionCurrent: (auth: { id: string }) => auth.id !== 'revoked',
}));
function fixture(login: string | null = 'signed-user') {
  const service = {
    list: vi.fn(() => []),
    create: vi.fn(async () => ({ id: 'timer' })),
    change: vi.fn(() => ({ id: 'timer', status: 'cancelled' })),
    sessions: vi.fn(async () => [{ sessionId: 'worker', title: 'Worker' }]),
  };
  const app = express();
  app.use(express.json(), (_req, res, next) => {
    if (login) res.locals.authSession = { id: login, expiresAt: Date.now() + 100000 };
    next();
  });
  app.use(
    '/api/session-timers',
    createSessionPromptRouter(service as unknown as SessionPromptService),
  );
  return { app, service };
}
it('requires a current human login; an internal token or forged actor cannot create timers', async () => {
  const f = fixture(null);
  expect((await request(f.app).get('/api/session-timers')).status).toBe(403);
  expect(
    (
      await request(f.app)
        .post('/api/session-timers')
        .set('X-Internal-Token', 'not-a-user')
        .send({})
    ).status,
  ).toBe(403);
  expect((await request(fixture('revoked').app).get('/api/session-timers')).status).toBe(403);
  expect(f.service.create).not.toHaveBeenCalled();
});
it('uses the signed actor and normal same-origin JSON protections for mutation', async () => {
  const f = fixture();
  const body = {
    requestId: '9fce2bfc-cffe-4b5a-99f7-e02670774e3a',
    sessionId: 'worker',
    prompt: 'Check PR #7',
    intervalMinutes: 10,
  };
  expect((await request(f.app).post('/api/session-timers').send(body)).status).toBe(201);
  expect(f.service.create).toHaveBeenCalledWith(
    expect.objectContaining(body),
    expect.objectContaining({ id: 'signed-user' }),
    'user',
    null,
  );
  expect(
    (
      await request(f.app)
        .post('/api/session-timers')
        .send({ ...body, createdBy: 'agent' })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(f.app)
        .post('/api/session-timers')
        .set('Origin', 'https://hostile.example')
        .send(body)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(f.app)
        .post('/api/session-timers/timer')
        .send({ requestId: body.requestId, expectedRevision: 1, action: 'cancel' })
    ).status,
  ).toBe(200);
  expect(f.service.change).toHaveBeenCalledWith(
    'timer',
    expect.objectContaining({ action: 'cancel' }),
    expect.objectContaining({ id: 'signed-user' }),
  );
});
it('exposes read-only sessions/list endpoints with no execution or private caching', async () => {
  const f = fixture();
  const response = await request(f.app).get('/api/session-timers?sessionId=worker');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toContain('no-store');
  expect(f.service.list).toHaveBeenCalledWith('worker');
  expect((await request(f.app).get('/api/session-timers/sessions')).body).toEqual([
    { sessionId: 'worker', title: 'Worker' },
  ]);
  expect(f.service.create).not.toHaveBeenCalled();
});
