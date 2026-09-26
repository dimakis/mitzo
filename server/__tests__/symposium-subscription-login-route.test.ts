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
