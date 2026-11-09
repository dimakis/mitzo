import { EventStore } from '../event-store.js';
import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDeploymentRouter } from '../deployment-routes.js';
import { login, authenticateToken, revokeAuthSession, setAuthRevocationStore } from '../auth.js';
import type { DeploymentCoordinator } from '../deployment-coordinator.js';

it('uses real signed operator authentication, rejects internal tokens and cross-origin mutation', async () => {
  const events = new EventStore(':memory:');
  setAuthRevocationStore(events);
  const coordinator = {
    store: { active: () => undefined },
    begin: vi.fn(() => ({ id: 'deployment' })),
    pause: vi.fn(async (_id: string, actor: { id: string; expiresAt: number }) => {
      revokeAuthSession(actor);
      throw Error('private-session-detail');
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/deployment',
    createDeploymentRouter(coordinator as unknown as DeploymentCoordinator),
  );
  const body = { id: 'bf5d32c9-7290-484d-8381-f02147b2c900', targetCommit: 'b'.repeat(40) };
  expect(
    (
      await request(app)
        .post('/api/deployment/begin')
        .set('X-Internal-Token', 'internal-agent')
        .send(body)
    ).status,
  ).toBe(403);
  expect(coordinator.begin).not.toHaveBeenCalled();
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const auth = (await authenticateToken(token))!;
  expect(
    (
      await request(app)
        .post('/api/deployment/begin')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'https://hostile.example')
        .send(body)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/api/deployment/begin')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body, actor: 'forged' })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post('/api/deployment/begin')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
    ).status,
  ).toBe(200);
  expect(coordinator.begin).toHaveBeenCalledWith(body.id, body.targetCommit, auth);
  const rejected = await request(app)
    .post('/api/deployment/pause')
    .set('Authorization', `Bearer ${token}`)
    .send({ id: body.id });
  expect(rejected.status).toBe(403);
  expect(JSON.stringify(rejected.body)).not.toMatch(/private-session-detail|active|snapshot/);
  expect(
    (
      await request(app)
        .post('/api/deployment/begin')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
    ).status,
  ).toBe(403);
  expect(coordinator.begin).toHaveBeenCalledOnce();
  events.close();
});
