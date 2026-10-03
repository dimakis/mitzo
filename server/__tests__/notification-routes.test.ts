import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { login, authMiddleware } from '../auth.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationCenter } from '../notification-center.js';
import { notificationRouter } from '../notification-routes.js';
import { registerPending, removePending } from '../permissions.js';

async function setup() {
  const store = new NotificationStore(':memory:');
  const center = new NotificationCenter(store, {
    push: vi.fn().mockResolvedValue('accepted'),
    changed: vi.fn(),
    configured: () => false,
    devices: () => 0,
    sessionTitle: () => undefined,
  });
  const app = express();
  app.use(express.json(), cookieParser(), authMiddleware);
  app.use('/api/notifications', notificationRouter(center));
  const token = await login(process.env.AUTH_PASSPHRASE!);
  return {
    app,
    store,
    center,
    token,
    close() {
      center.close();
      store.close();
    },
  };
}
describe('notification API', () => {
  it('requires login and rejects invalid preferences', async () => {
    const s = await setup();
    expect((await request(s.app).get('/api/notifications')).status).toBe(401);
    expect(
      (
        await request(s.app)
          .put('/api/notifications/preferences')
          .set('Authorization', `Bearer ${s.token}`)
          .send({ quietStart: '25:00' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(s.app)
          .put('/api/notifications/preferences')
          .set('Authorization', `Bearer ${s.token}`)
          .send({ timezone: 'Mars' })
      ).status,
    ).toBe(400);
    s.close();
  });
  it('reads without resolving and rejects stale or cross-session approvals', async () => {
    const s = await setup();
    const resolver = vi.fn();
    const permId = 'route-perm';
    registerPending(permId, 'Bash', resolver, {}, 'elevated', 's1', {
      permId,
      toolName: 'Bash',
      toolInput: 'npm test',
      sessionId: 's1',
      expiresAt: Date.now() + 60000,
    });
    const auth = `Bearer ${s.token}`;
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/read`)
          .set('Authorization', auth)
      ).status,
    ).toBe(200);
    expect(s.store.feed('needs').needsYou).toBe(1);
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/respond`)
          .set('Authorization', auth)
          .send({ sessionId: 'other', decision: 'once' })
      ).status,
    ).toBe(409);
    expect(resolver).not.toHaveBeenCalled();
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/respond`)
          .set('Authorization', auth)
          .send({ sessionId: 's1', decision: 'once' })
      ).status,
    ).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(s.app)
          .post(`/api/notifications/permission:${permId}/respond`)
          .set('Authorization', auth)
          .send({ sessionId: 's1', decision: 'once' })
      ).status,
    ).toBe(409);
    removePending(permId);
    s.close();
  });
});
