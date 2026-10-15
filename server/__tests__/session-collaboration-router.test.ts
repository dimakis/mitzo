import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { createSessionCollaborationRouter } from '../session-collaboration-router.js';
let store: EventStore, app: express.Express, path: string;
beforeEach(() => {
  store = new EventStore(':memory:');
  path = `/api/session-collaborations/${randomUUID()}`;
  for (const sessionId of ['first', 'local', 'sandbox'])
    store.upsertSession({ sessionId, conversationSource: 'mitzo' });
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('x-operator') === 'yes')
      res.locals.authSession = {
        id: 'operator',
        expiresAt: req.header('x-expired') ? Date.now() - 1 : Date.now() + 60000,
      };
    next();
  });
  app.use('/api/session-collaborations', createSessionCollaborationRouter({ store }));
});
afterEach(() => store.close());
const body = { expectedRevision: 0, participantSessionIds: ['first', 'local'] };
it('requires interactive operator authorization on reads and mutations', async () => {
  expect((await request(app).get(path)).status).toBe(401);
  expect((await request(app).get('/api/session-collaborations?sessionId=local')).status).toBe(401);
  expect((await request(app).put(path).send(body)).status).toBe(401);
  expect(
    (await request(app).get(path).set('x-operator', 'yes').set('x-expired', 'yes')).status,
  ).toBe(401);
});
it('links, reopens and unlinks real existing sessions without executing or creating a chat', async () => {
  const response = await request(app).put(path).set('x-operator', 'yes').send(body);
  expect(response.status).toBe(200);
  expect((await request(app).get(path).set('x-operator', 'yes')).body).toEqual({
    ...response.body,
    unavailableParticipantSessionIds: [],
  });
  expect(response.headers['cache-control']).toContain('no-store');
  const discovery = await request(app)
    .get('/api/session-collaborations?sessionId=local')
    .set('x-operator', 'yes');
  expect(discovery.body.collaborations).toEqual([response.body]);
  expect(discovery.body.nextCursor).toBeNull();
  expect(
    (
      await request(app)
        .get('/api/session-collaborations?sessionId=missing')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(404);
  expect(
    (
      await request(app)
        .get('/api/session-collaborations?sessionId=local&after=invalid')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(400);
  store.hideSession('first');
  expect(
    (await request(app).get(path).set('x-operator', 'yes')).body.unavailableParticipantSessionIds,
  ).toEqual(['first']);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ expectedRevision: 1, participantSessionIds: ['local'] })
    ).status,
  ).toBe(200);
  expect(store.listSessions()).toHaveLength(2);
  expect(store.getSession('first')).toMatchObject({ sessionId: 'first', isHidden: true });
  expect(store.getSessionEvents('local')).toEqual([]);
});
it('rejects cross-origin writes, stale revisions, unknown participants and execution fields', async () => {
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .set('Origin', 'https://other.invalid')
        .send(body)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ ...body, model: 'replacement' })
    ).status,
  ).toBe(400);
  expect((await request(app).put(path).set('x-operator', 'yes').send(body)).status).toBe(200);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ ...body, participantSessionIds: ['first', 'sandbox'] })
    ).status,
  ).toBe(409);
  expect(
    (await request(app).get(`/api/session-collaborations/${randomUUID()}`).set('x-operator', 'yes'))
      .status,
  ).toBe(404);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ expectedRevision: 1, participantSessionIds: ['local', 'missing'] })
    ).status,
  ).toBe(404);
});
