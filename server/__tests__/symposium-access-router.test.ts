import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createSymposiumAccessRouter } from '../symposium-access-router.js';
it('requires interactive authentication and rejects edited approval payloads', async () => {
  const service = {
    list: vi.fn().mockReturnValue([]),
    decide: vi.fn(),
    dismiss: vi.fn(),
    handoff: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('x-test-auth'))
      res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 10000 };
    next();
  });
  app.use(
    '/sessions/:id/access',
    createSymposiumAccessRouter(service, (id) => id === 'session'),
  );
  expect((await request(app).get('/sessions/session/access')).status).toBe(403);
  expect(
    (await request(app).get('/sessions/session/access').set('x-test-auth', 'yes')).status,
  ).toBe(200);
  expect(
    (
      await request(app)
        .post('/sessions/session/access/request/decision')
        .set('x-test-auth', 'yes')
        .send({ hash: 'a'.repeat(64), approved: true, url: 'http://other/' })
    ).status,
  ).toBe(400);
  expect(service.decide).not.toHaveBeenCalled();
  expect(
    (
      await request(app)
        .post('/sessions/session/access/request/decision')
        .set('x-test-auth', 'yes')
        .send({ hash: 'a'.repeat(64), approved: true })
    ).status,
  ).toBe(200);
  expect(service.decide).toHaveBeenCalledWith('session', 'request', 'a'.repeat(64), true);
  expect(
    (
      await request(app)
        .post('/sessions/session/access/request/handoff')
        .set('x-test-auth', 'yes')
        .send({ hash: 'a'.repeat(64) })
    ).status,
  ).toBe(200);
  expect(service.handoff).toHaveBeenCalledWith('session', 'request', 'a'.repeat(64));
});
