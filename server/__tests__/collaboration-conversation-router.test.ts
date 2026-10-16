import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { createSessionCollaborationRouter } from '../session-collaboration-router.js';
import {
  CollaborationApiClient,
  createCollaborationProjection,
  applyCollaborationEvents,
} from '@mitzo/client';

let store: EventStore, app: express.Express, path: string, server: Server;
beforeEach(async () => {
  store = new EventStore(':memory:');
  const group = randomUUID();
  path = `/api/session-collaborations/${group}`;
  for (const sessionId of ['one', 'two'])
    store.upsertSession({ sessionId, conversationSource: 'mitzo' });
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two'],
  });
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('x-operator') === 'yes')
      res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60_000 };
    next();
  });
  app.use('/api/session-collaborations', createSessionCollaborationRouter({ store }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  store.close();
});
function policy() {
  return {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedRevision: 0,
    sessionId: 'two',
    readsFutureDiscussion: true,
    repliesByDefault: false,
  };
}

it('authenticates all conversation reads and mutations and rejects cross-origin JSON writes', async () => {
  for (const suffix of [
    '/conversation',
    '/events',
    `/snapshots/${randomUUID()}`,
    `/joins/${randomUUID()}`,
  ])
    expect((await request(server).get(path + suffix)).status).toBe(401);
  expect(
    (
      await request(server)
        .put(path + '/policy')
        .send(policy())
    ).status,
  ).toBe(401);
  for (const suffix of ['/messages', '/joins', '/snapshots'])
    expect(
      (
        await request(server)
          .post(path + suffix)
          .send({})
      ).status,
    ).toBe(401);
  expect(
    (
      await request(server)
        .put(path + '/policy')
        .set('x-operator', 'yes')
        .set('Origin', 'https://other.invalid')
        .send(policy())
    ).status,
  ).toBe(403);
});

it('publishes versioned policies, exact receipts and bounded cursor replay without side effects', async () => {
  const input = policy();
  const result = await request(server)
    .put(path + '/policy')
    .set('x-operator', 'yes')
    .send(input);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ revision: 1, effectiveFromSequence: 2 });
  expect(
    (
      await request(server)
        .put(path + '/policy')
        .set('x-operator', 'yes')
        .send(input)
    ).body,
  ).toEqual(result.body);
  expect(
    (
      await request(server)
        .put(path + '/policy')
        .set('x-operator', 'yes')
        .send({ ...input, repliesByDefault: true })
    ).body.code,
  ).toBe('request_conflict');
  const view = await request(server)
    .get(path + '/conversation')
    .set('x-operator', 'yes');
  expect(view.status).toBe(200);
  expect(view.headers['cache-control']).toContain('no-store');
  expect(view.body).toMatchObject({ cursor: 1, policySequence: 1, execution: { enabled: false } });
  const replay = await request(server)
    .get(path + '/events?after=0')
    .set('x-operator', 'yes');
  expect(replay.body).toMatchObject({ cursor: 1, highWatermark: 1, hasMore: false });
  expect(replay.body.events[0].change.kind).toBe('policy');
  expect(
    (
      await request(server)
        .get(path + '/events?after=2')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(409);
  expect(
    (
      await request(server)
        .get(path + '/events?after=bad')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(400);
  expect(
    (
      await request(server)
        .get(path + '/events?after=0&extra=true')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(400);
  expect(store.listSessions()).toHaveLength(2);
  expect(store.getSessionEvents('two')).toEqual([]);
});

it('keeps unfinished execution and source compilation disabled with a typed reason', async () => {
  for (const suffix of ['/messages', '/joins', '/snapshots']) {
    const response = await request(server)
      .post(path + suffix)
      .set('x-operator', 'yes')
      .send({});
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'execution_unavailable',
      execution: { enabled: false },
    });
  }
  expect(
    (
      await request(server)
        .get(path + '/conversation')
        .set('x-operator', 'yes')
    ).body.cursor,
  ).toBe(0);
  expect(store.listSessions()).toHaveLength(2);
});

it('does not accept receipt forgery or arbitrary source bytes and distinguishes invalid/missing identities', async () => {
  expect(
    (
      await request(server)
        .put(path + '/policy')
        .set('x-operator', 'yes')
        .send({ ...policy(), accountId: 'forged' })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(server)
        .put(path + '/policy')
        .set('x-operator', 'yes')
        .send({ ...policy(), sessionId: 'unknown' })
    ).body.code,
  ).toBe('unknown_recipient');
  store.hideSession('two');
  expect(
    (
      await request(server)
        .put(path + '/policy')
        .set('x-operator', 'yes')
        .send(policy())
    ).body.code,
  ).toBe('unavailable_recipient');
  expect(
    (
      await request(server)
        .get(path + `/snapshots/${randomUUID()}`)
        .set('x-operator', 'yes')
    ).status,
  ).toBe(404);
  expect(
    (
      await request(server)
        .get(path + '/snapshots/invalid')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(400);
  expect(
    (
      await request(server)
        .get(`/api/session-collaborations/${randomUUID()}/conversation`)
        .set('x-operator', 'yes')
    ).status,
  ).toBe(404);
  expect(
    (
      await request(server)
        .post(path + '/receipts')
        .set('x-operator', 'yes')
        .send({ status: 'delivered' })
    ).status,
  ).toBe(404);
});

it('round-trips the shared typed client through authenticated Express and durable replay', async () => {
  const api = new CollaborationApiClient(async (url, init) => {
    const operation = init?.method === 'PUT' ? request(server).put(url) : request(server).get(url);
    operation.set('x-operator', 'yes');
    if (init?.body) operation.send(JSON.parse(String(init.body)));
    const response = await operation;
    return new Response(JSON.stringify(response.body), { status: response.status });
  });
  const group = path.split('/').at(-1)!;
  const initial = createCollaborationProjection(await api.view(group));
  await api.setPolicy(group, policy());
  const next = applyCollaborationEvents(initial, await api.events(group, initial.view.cursor));
  expect(next.needsRefresh).toBe(false);
  expect(next.view).toEqual(await api.view(group));
});
