import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionLoginHandler } from '../symposium-subscription-login-route.js';

function fixture() {
  const beginLogin = vi.fn().mockResolvedValue({
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake-state',
    completed: Promise.resolve(),
  });
  const app = express();
  app.use(express.json());
  app.post(
    '/login',
    createSubscriptionLoginHandler(() => ({ beginLogin })),
  );
  return { app, beginLogin };
}

describe('personal login callback workflow (no provider calls)', () => {
  it.each([{}, { callbackTransport: 'remote' }, { callbackTransport: ['host-local'] }])(
    'refuses unprepared clients before starting OAuth: %j',
    async (body) => {
      const { app, beginLogin } = fixture();
      const response = await request(app).post('/login').send(body);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('callback_transport_required');
      expect(response.body.authorizationUrl).toBeUndefined();
      expect(response.body.transports['ssh-forwarded']).toContain(
        '-L 127.0.0.1:1455:127.0.0.1:1455',
      );
      expect(response.body.limitation).toContain('phone');
      expect(beginLogin).not.toHaveBeenCalled();
    },
  );

  it('does not infer browser reachability from loopback requests or forwarded headers', async () => {
    const { app, beginLogin } = fixture();
    const response = await request(app)
      .post('/login')
      .set('Host', 'localhost')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({});
    expect(response.status).toBe(409);
    expect(beginLogin).not.toHaveBeenCalled();
  });

  it.each(['host-local', 'ssh-forwarded'])(
    'starts the explicitly prepared %s flow',
    async (mode) => {
      const { app, beginLogin } = fixture();
      const response = await request(app).post('/login').send({ callbackTransport: mode });
      expect(response.status).toBe(200);
      expect(beginLogin).toHaveBeenCalledTimes(1);
      expect(response.body.authorizationUrl).toMatch(/^https:\/\/auth.openai.com\//);
      expect(response.body.callbackUrl).toBe('http://localhost:1455/auth/callback');
      expect(response.body.callbackTransport).toBe(mode);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('sanitizes listener failures and gives an actionable port diagnostic', async () => {
    const { app, beginLogin } = fixture();
    beginLogin.mockRejectedValue(new Error('EADDRINUSE fake-secret'));
    const response = await request(app).post('/login').send({ callbackTransport: 'host-local' });
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('port 1455');
    expect(JSON.stringify(response.body)).not.toContain('fake-secret');
  });
});

it('tracks pending/completed without exposing URLs and reports an unknown receipt after restart', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  let finish!: () => void;
  const beginLogin = vi.fn().mockResolvedValue({
    authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=private',
    completed: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  });
  const controller = createSubscriptionLoginController(() => ({ beginLogin }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  expect((await request(app).get('/status')).body.state).toBe('idle');
  const start = await request(app).post('/login').send({ callbackTransport: 'host-local' });
  expect(start.body.attemptId).toEqual(expect.any(String));
  const status = await request(app).get('/status').query({ attemptId: start.body.attemptId });
  expect(status.body).toEqual({ state: 'pending', attemptId: start.body.attemptId });
  expect(status.headers['cache-control']).toBe('no-store');
  expect((await request(app).post('/login').send({ callbackTransport: 'host-local' })).status).toBe(
    409,
  );
  expect(beginLogin).toHaveBeenCalledTimes(1);
  finish();
  expect(
    (await request(app).get('/status').query({ attemptId: start.body.attemptId })).body.state,
  ).toBe('completed');
  const restarted = express();
  restarted.get('/status', createSubscriptionLoginController(() => ({ beginLogin })).status);
  expect(
    (await request(restarted).get('/status').query({ attemptId: start.body.attemptId })).body.state,
  ).toBe('unknown');
});

it('sanitizes failed completions and prevents a stale receipt from reporting a new attempt', async () => {
  const { createSubscriptionLoginController } =
    await import('../symposium-subscription-login-route.js');
  const beginLogin = vi.fn().mockImplementation(async () => ({
    authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    completed: Promise.reject(new Error('token=secret')),
  }));
  const controller = createSubscriptionLoginController(() => ({ beginLogin }));
  const app = express();
  app.use(express.json());
  app.post('/login', controller.start);
  app.get('/status', controller.status);
  const first = await request(app).post('/login').send({ callbackTransport: 'host-local' });
  expect(
    (await request(app).get('/status').query({ attemptId: first.body.attemptId })).body,
  ).toEqual({ state: 'failed', attemptId: first.body.attemptId });
  const next = await request(app).post('/login').send({ callbackTransport: 'ssh-forwarded' });
  expect(next.body.attemptId).not.toBe(first.body.attemptId);
  expect(
    (await request(app).get('/status').query({ attemptId: first.body.attemptId })).body,
  ).toEqual({ state: 'unknown' });
});
