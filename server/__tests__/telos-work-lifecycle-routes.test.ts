import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { revokeAuthSession } from '../auth.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';

const servers: Server[] = [];
const closes: Array<() => void> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeTestServer(server);
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
async function fixture() {
  const canonical = createTelosCanonicalData();
  closes.push(() => canonical.close());
  const authorization = {
    id: `lifecycle-operator-${Math.random()}`,
    expiresAt: Date.now() + 60000,
  };
  const assertLifecycleQuiescent = vi.fn(() => {});
  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath: () => canonical.dbPath,
      operatorAuth: (req, res, next) => {
        if (req.headers['x-operator'] !== 'interactive') {
          res.status(403).json({ error: 'Operator required' });
          return;
        }
        res.locals.authSession = authorization;
        next();
      },
      ordinaryConversation: () => true,
      verifyInternal: (req) => req.headers['x-internal-token'] === 'internal',
      sessionId: () => 'planning',
      assertLifecycleQuiescent,
    }),
  );
  const server = await listenOnLoopback(app);
  servers.push(server);
  const post = (body: object) =>
    request(server).post('/api/telos/work/lifecycle').set('x-operator', 'interactive').send(body);
  const read = () =>
    request(server).get('/api/telos/work/items/studio/lifecycle').set('x-operator', 'interactive');
  const input = (operation = 'trash') => ({
    operation,
    itemId: 'studio',
    requestId: `req-${Math.random()}`,
    expectedRevision: canonical.work.read('studio', canonical.actor).revision,
  });
  return { canonical, authorization, assertLifecycleQuiescent, server, post, read, input };
}

it('derives interactive lifecycle authority, applies canonical revision and retains exact replay through HTTP', async () => {
  const f = await fixture();
  expect((await f.read()).status).toBe(200);
  const input = f.input();
  const response = await f.post(input);
  expect(response.status).toBe(200);
  expect(response.body.lifecycle.disposition).toBe('trashed');
  expect(response.body.lifecycle.history[0].actorId).toBe(`operator:${f.authorization.id}`);
  expect((await f.post(input)).body).toEqual(response.body);
  expect((await f.post({ ...input, requestId: 'stale', operation: 'restore' })).status).toBe(409);
  const list = await request(f.server)
    .get('/api/telos/work/lifecycle?view=trash')
    .set('x-operator', 'interactive');
  expect(list.status).toBe(200);
  expect(list.body.map((v: { itemId: string }) => v.itemId)).toContain('studio');
  expect((await f.post(f.input('restore'))).body.lifecycle.disposition).toBe('active');
});

it('refuses internal-token actors, forged fields, expired/revoked auth and cross-site requests before mutation', async () => {
  const f = await fixture();
  const input = f.input();
  expect(
    (
      await request(f.server)
        .post('/api/telos/work/lifecycle')
        .set('x-internal-token', 'internal')
        .send(input)
    ).status,
  ).toBe(403);
  expect((await f.post({ ...input, actorId: 'forged', acknowledged: true })).status).toBe(400);
  expect(
    (
      await request(f.server)
        .post('/api/telos/work/lifecycle')
        .set('x-operator', 'interactive')
        .set('Origin', 'https://evil.test')
        .send(input)
    ).status,
  ).toBe(403);
  f.authorization.expiresAt = Date.now() - 1;
  expect((await f.post(input)).status).toBe(403);
  f.authorization.expiresAt = Date.now() + 60000;
  revokeAuthSession(f.authorization);
  expect((await f.post(input)).status).toBe(403);
  expect(f.canonical.work.readRecord('studio', f.canonical.actor).status).toBe('active');
});

it('has no JSON path to host quiescence and requires separate explicit permanent confirmation', async () => {
  const f = await fixture();
  expect((await f.post(f.input())).status).toBe(200);
  expect((await f.post(f.input('delete_permanently'))).status).toBe(400);
  expect(
    (
      await f.post({
        ...f.input('delete_permanently'),
        confirmation: { itemId: 'different', phrase: 'DELETE PERMANENTLY' },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post({
        ...f.input('delete_permanently'),
        confirmation: { itemId: 'studio', phrase: 'DELETE PERMANENTLY' },
        assertQuiescent: true,
      })
    ).status,
  ).toBe(400);
  expect(f.assertLifecycleQuiescent).not.toHaveBeenCalled();
  expect((await f.read()).body.disposition).toBe('trashed');
});
