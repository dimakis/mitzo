import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createAppleSignIn } from '../apple-sign-in.js';
import { createAppleSignInRouter } from '../apple-sign-in-router.js';

function responseCookies(response: { headers: Record<string, unknown> }): string[] {
  const cookies = response.headers['set-cookie'];
  if (!Array.isArray(cookies) || !cookies.every((value) => typeof value === 'string'))
    throw new Error('Expected separate Set-Cookie header values');
  return cookies;
}

function fixture() {
  let owner: string | null = 'apple-owner';
  const config = {
    clientId: 'com.example.web',
    nativeClientId: 'com.example.app',
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    privateKeyPath: '/test.p8',
    redirectUri: 'https://mitzo.example/api/auth/apple/callback',
  };
  const verify = vi.fn(async () => ({ subject: 'apple-owner' }));
  const log = vi.fn();
  const service = createAppleSignIn({
    config,
    store: {
      read: () => owner,
      enroll: (subject) => {
        owner = subject;
      },
    },
    verify,
    verifyPassphrase: (value) => value === 'owner-proof',
    issueSession: async () => 'ordinary-operator-jwt',
  });
  const app = express();
  app.use(cookieParser());
  app.use(
    '/api/auth/apple',
    createAppleSignInRouter({ config, service, cookieName: 'cc_auth', maxAgeHours: 24, warn: log }),
  );
  app.use('/api', (_req, res) => res.status(401).json({ error: 'Ordinary auth required' }));
  return {
    app,
    verify,
    log,
    unenroll: () => {
      owner = null;
    },
  };
}
describe('Apple authentication HTTP boundary', () => {
  it('contains parser failures without exposing secret request bodies or stack traces', async () => {
    const f = fixture();
    const result = await request(f.app)
      .post('/api/auth/apple/start')
      .set('Origin', 'https://mitzo.example')
      .set('Content-Type', 'application/json')
      .send('{"enrollPassphrase":"private-malformed-proof",');
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('invalid_request');
    expect(result.text).not.toContain('private-malformed-proof');
    expect(f.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stage: 'parse', code: 'invalid_request' }),
    );
  });
  it('returns disabled status without touching configured keys or stores', async () => {
    const app = express();
    app.use(
      '/api/auth/apple',
      createAppleSignInRouter({
        service: null,
        config: null,
        cookieName: 'cc_auth',
        maxAgeHours: 24,
        warn: vi.fn(),
      }),
    );
    expect((await request(app).get('/api/auth/apple/status')).body).toEqual({ enabled: false });
    expect((await request(app).post('/api/auth/apple/start').send({ client: 'web' })).status).toBe(
      404,
    );
  });

  it('completes a cookie-bound callback without putting an app token in the URL or body', async () => {
    const f = fixture();
    const start = await request(f.app)
      .post('/api/auth/apple/start')
      .set('Origin', 'https://mitzo.example')
      .send({ client: 'web' });
    expect(start.status).toBe(200);
    expect(Object.keys(start.body)).toEqual(['authorizationUrl']);
    const bindingCookie = responseCookies(start)[0];
    expect(bindingCookie).toContain('HttpOnly');
    expect(bindingCookie).toContain('Secure');
    expect(bindingCookie).toContain('SameSite=Lax');
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');
    const callback = await request(f.app)
      .get('/api/auth/apple/callback')
      .query({ state, code: 'single-use-code' })
      .set('Cookie', bindingCookie.split(';')[0]);
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe('/login?apple=success');
    const cookie = responseCookies(callback).find((value) => value.startsWith('cc_auth='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(callback.text).not.toContain('ordinary-operator-jwt');
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
  });

  it('refuses missing cookies, foreign origins and a native/web transaction mixup', async () => {
    const f = fixture();
    const denied = await request(f.app)
      .post('/api/auth/apple/start')
      .set('Origin', 'https://other.example')
      .send({ client: 'web' });
    expect(denied.status).toBe(403);
    expect(
      (await request(f.app).post('/api/auth/apple/start').send({ client: 'web' })).status,
    ).toBe(403);
    const start = await request(f.app)
      .post('/api/auth/apple/start')
      .set('Origin', 'capacitor://localhost')
      .send({ client: 'native' });
    expect(start.status).toBe(200);
    const wrong = await request(f.app)
      .get('/api/auth/apple/callback')
      .query({ state: start.body.state, code: 'code' });
    expect(wrong.headers.location).toContain('apple=error');
    expect(f.verify).not.toHaveBeenCalled();
    const native = await request(f.app)
      .post('/api/auth/apple/native')
      .set('Origin', 'capacitor://localhost')
      .send({ state: start.body.state, verifier: start.body.verifier, code: 'native-code' });
    expect(native.status).toBe(200);
    expect(native.body.token).toBe('ordinary-operator-jwt');
  });

  it('requires the owner passphrase for first enrollment and never logs it', async () => {
    const f = fixture();
    f.unenroll();
    const failed = await request(f.app)
      .post('/api/auth/apple/start')
      .set('Origin', 'https://mitzo.example')
      .send({ client: 'web', enrollPassphrase: 'private-secret' });
    expect(failed.status).toBe(403);
    expect(failed.body.code).toBe('enrollment_denied');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('private-secret');
  });

  it('settles upstream failure with a sanitized diagnostic and a retryable login page', async () => {
    const f = fixture();
    f.verify.mockRejectedValueOnce(new Error('secret provider payload'));
    const start = await request(f.app)
      .post('/api/auth/apple/start')
      .set('Origin', 'capacitor://localhost')
      .send({ client: 'native' });
    const result = await request(f.app)
      .post('/api/auth/apple/native')
      .set('Origin', 'capacitor://localhost')
      .send({ state: start.body.state, verifier: start.body.verifier, code: 'private-code' });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('service_unavailable');
    expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/secret provider payload|private-code/);
    expect(f.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        stage: 'native',
        code: 'service_unavailable',
      }),
    );
  });
});
