import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConnectionsRouter } from '../connections-router.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));
describe('Google Workspace operator routes', () => {
  it('requires a browser session, same origin and fresh authorization before importing host credentials', async () => {
    const google = {
      status: vi.fn(async () => ({
        health: 'ready',
        expiresAt: Date.now() + 60000,
        slidesEditing: true,
      })),
      preview: vi.fn(async () => ({ email: 'user@example.com' })),
      reconnect: vi.fn(async () => ({ health: 'ready' })),
      rotate: vi.fn(async () => ({ health: 'ready' })),
    };
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'google-router-test', expiresAt: Date.now() + 60000 };
      next();
    });
    app.use(
      '/api/connections',
      createConnectionsRouter({
        store: {} as never,
        service: {} as never,
        eligibleAccounts: () => [],
        gateway: 'openshell',
        workspace: 'default',
        legacyProviders: async () => [],
        googleWorkspace: google as never,
      }),
    );
    expect((await request(app).get('/api/connections/google-workspace')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/connections/google-workspace/preview')
          .set('x-browser', 'yes')
          .send({ csrf: 'no' })
      ).status,
    ).toBe(403);
    const auth = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    const csrf = auth.body.csrf;
    expect(
      (
        await request(app)
          .post('/api/connections/google-workspace/preview')
          .set('x-browser', 'yes')
          .set('Origin', 'https://untrusted.example')
          .send({ csrf })
      ).status,
    ).toBe(403);
    expect(google.preview).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .post('/api/connections/google-workspace/preview')
          .set('x-browser', 'yes')
          .send({ csrf })
      ).body,
    ).toEqual({ email: 'user@example.com' });
    expect(
      (
        await request(app)
          .post('/api/connections/google-workspace/reconnect')
          .set('x-browser', 'yes')
          .send({ csrf, email: 'user@example.com', credentials: 'do not accept' })
      ).status,
    ).toBe(400);
    expect(google.reconnect).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .post('/api/connections/google-workspace/reconnect')
          .set('x-browser', 'yes')
          .send({ csrf, email: 'user@example.com' })
      ).status,
    ).toBe(200);
    expect(google.reconnect).toHaveBeenCalledWith('user@example.com', expect.any(AbortSignal));
  });
});
