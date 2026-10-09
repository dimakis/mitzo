import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { login, authMiddleware } from '../auth.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationCenter } from '../notification-center.js';
import { notificationRouter } from '../notification-routes.js';
import { INTERNAL_TOKEN } from '../internal-token.js';
import { registerPending, removePending } from '../permissions.js';

async function setup() {
  const store = new NotificationStore(':memory:');
  const center = new NotificationCenter(store, {
    push: vi.fn().mockResolvedValue({ status: 'accepted', acceptedDevices: [] }),
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
  it('keeps internal agents out and reads older linked items independently of pagination', async () => {
    const s = await setup();
    s.store.record({ id: 'old', kind: 'session', title: 'Older result', body: 'Summary' }, 1);
    expect(
      (await request(s.app).get('/api/notifications/old').set('X-Internal-Token', INTERNAL_TOKEN))
        .status,
    ).toBe(403);
    const response = await request(s.app)
      .get('/api/notifications/old')
      .set('Authorization', `Bearer ${s.token}`);
    expect(response.status).toBe(200);
    expect(response.body.title).toBe('Older result');
    s.close();
  });
  it.each(['search', 'fetch', 'shell'])(
    'restricts session notification grants to search, not %s',
    async (operation) => {
      const s = await setup();
      const resolver = vi.fn();
      const permId = `session-${operation}`;
      const input = { operation, query: 'Pricing', reason: 'Research' };
      registerPending(permId, 'RequestWebAccess', resolver, input, 'unknown', 's1', {
        permId,
        toolName: 'RequestWebAccess',
        toolInput: JSON.stringify(input),
        sessionId: 's1',
        approvalScope: operation === 'search' ? 'session' : 'request',
      });
      const response = await request(s.app)
        .post(`/api/notifications/permission:${permId}/respond`)
        .set('Authorization', `Bearer ${s.token}`)
        .send({ sessionId: 's1', decision: 'always' });
      expect(response.status).toBe(operation === 'search' ? 200 : 400);
      if (operation === 'search')
        expect(resolver).toHaveBeenCalledWith(
          expect.objectContaining({ decisionClassification: 'user_permanent' }),
        );
      else expect(resolver).not.toHaveBeenCalled();
      removePending(permId);
      s.close();
    },
  );
  it('requires session review for conversation-scoped grants', async () => {
    const s = await setup();
    const resolver = vi.fn();
    const permId = 'durable-grant';
    registerPending(permId, 'GrantIntegration', resolver, {}, 'elevated', 's1', {
      permId,
      toolName: 'GrantIntegration',
      toolInput: '{}',
      sessionId: 's1',
      approvalScope: 'conversation',
    });
    const response = await request(s.app)
      .post(`/api/notifications/permission:${permId}/respond`)
      .set('Authorization', `Bearer ${s.token}`)
      .send({ sessionId: 's1', decision: 'once' });
    expect(response.status).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    removePending(permId);
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

it('archives and restores for operators without hiding a live approval or granting consent', async () => {
  const s = await setup();
  const resolver = vi.fn();
  const permId = 'archive-live';
  try {
    registerPending(permId, 'Bash', resolver, {}, 'elevated', 's1', {
      permId,
      toolName: 'Bash',
      toolInput: 'npm test',
      sessionId: 's1',
      expiresAt: Date.now() + 60000,
    });
    s.store.record({ id: 'done', kind: 'session', title: 'Done', body: '' });
    s.store.markRead('done');
    for (const path of ['/archive-resolved', '/done/archive', '/done/restore']) {
      expect((await request(s.app).post('/api/notifications' + path)).status).toBe(401);
      expect(
        (
          await request(s.app)
            .post('/api/notifications' + path)
            .set('X-Internal-Token', INTERNAL_TOKEN)
        ).status,
      ).toBe(403);
    }
    const auth = { Authorization: `Bearer ${s.token}` };
    expect(
      (await request(s.app).post(`/api/notifications/permission:${permId}/archive`).set(auth))
        .status,
    ).toBe(409);
    expect((await request(s.app).post('/api/notifications/missing/archive').set(auth)).status).toBe(
      404,
    );
    expect(
      (await request(s.app).post('/api/notifications/archive-resolved').set(auth)).body.archived,
    ).toBe(1);
    const feed = await request(s.app).get('/api/notifications?filter=archived').set(auth);
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((i: { id: string }) => i.id)).toEqual(['done']);
    expect((await request(s.app).get('/api/notifications/done').set(auth)).body.archivedAt).toEqual(
      expect.any(Number),
    );
    expect((await request(s.app).post('/api/notifications/done/restore').set(auth)).status).toBe(
      200,
    );
    expect(s.store.feed().items.some((i) => i.id === 'done')).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
  } finally {
    removePending(permId);
    s.close();
  }
});
