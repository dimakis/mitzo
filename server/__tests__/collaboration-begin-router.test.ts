import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { createSessionCollaborationRouter } from '../session-collaboration-router.js';

let store: EventStore, directory: string, dbPath: string;
const review = vi.fn(() => {
  throw new Error('Begin must not construct a review owner');
});
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, res, next) => {
    if (req.header('x-operator') === 'yes')
      res.locals.authSession = { id: 'begin-operator', expiresAt: Date.now() + 60_000 };
    next();
  });
  instance.use('/api/session-collaborations', createSessionCollaborationRouter({ store, review }));
  return instance;
}
const route = (group: string) => `/api/session-collaborations/${group}/begin`;
const input = () => ({ requestId: randomUUID(), sessionId: 'ordinary-source' });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'symposium-begin-'));
  dbPath = join(directory, 'events.db');
  store = new EventStore(dbPath);
  store.upsertSession({ sessionId: 'ordinary-source', conversationSource: 'mitzo' });
  store.upsertSession({ sessionId: 'other-source', conversationSource: 'mitzo' });
  review.mockClear();
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('starts from one real ordinary source without allocating, reviewing or running a turn', async () => {
  const group = randomUUID();
  const allocate = vi.spyOn(store, 'prepareOrdinarySession');
  const before = store.listSessions();
  const response = await request(app()).post(route(group)).set('x-operator', 'yes').send(input());
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    version: 1,
    collaborationId: group,
    revision: 1,
    participantSessionIds: ['ordinary-source'],
  });
  expect(response.headers['cache-control']).toContain('no-store');
  expect(store.listSessions()).toEqual(before);
  expect(store.getSessionEvents('ordinary-source')).toEqual([]);
  expect(store.collaborationConversation.view(group).cursor).toBe(0);
  expect(allocate).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});

it('recovers the exact lost response after restart and source loss without replacing its identity', async () => {
  const group = randomUUID(),
    body = input();
  const first = await request(app()).post(route(group)).set('x-operator', 'yes').send(body);
  expect(first.status).toBe(200);
  store.close();
  store = new EventStore(dbPath);
  store.hideSession('ordinary-source');
  const retry = await request(app()).post(route(group)).set('x-operator', 'yes').send(body);
  expect(retry.status).toBe(200);
  expect(retry.body).toEqual(first.body);
  expect(store.collaborationConversation.view(group).cursor).toBe(0);
  expect(store.getSessionEvents('ordinary-source')).toEqual([]);
  expect(review).not.toHaveBeenCalled();
});

it('arbitrates concurrent exact retries and competing group identities through the existing owner', async () => {
  const instance = app(),
    group = randomUUID(),
    body = input();
  const same = await Promise.all(
    [1, 2].map(() => request(instance).post(route(group)).set('x-operator', 'yes').send(body)),
  );
  expect(same.map((response) => response.status)).toEqual([200, 200]);
  expect(same[0].body).toEqual(same[1].body);
  const competing = randomUUID();
  expect(
    (await request(instance).post(route(competing)).set('x-operator', 'yes').send(input())).status,
  ).toBe(409);
  expect(store.getSessionCollaboration(competing)).toBeNull();
  expect(store.listSessionCollaborations('ordinary-source').collaborations).toEqual([same[0].body]);
});

it('refuses identity reuse with another source and refuses extra caller authority', async () => {
  const group = randomUUID(),
    body = input(),
    instance = app();
  expect(
    (await request(instance).post(route(group)).set('x-operator', 'yes').send(body)).status,
  ).toBe(200);
  const reused = await request(instance)
    .post(route(group))
    .set('x-operator', 'yes')
    .send({ ...body, sessionId: 'other-source' });
  expect(reused.status).toBe(409);
  expect(reused.body.code).toBe('request_conflict');
  for (const extra of [
    { participantSessionIds: ['other-source'] },
    { settings: {} },
    { operatorId: 'caller' },
  ]) {
    const id = randomUUID();
    expect(
      (
        await request(instance)
          .post(route(id))
          .set('x-operator', 'yes')
          .send({ ...input(), ...extra })
      ).status,
    ).toBe(400);
    expect(store.getSessionCollaboration(id)).toBeNull();
  }
});

it('requires current operator authorization and same-origin JSON before mutation', async () => {
  const group = randomUUID(),
    instance = app();
  expect((await request(instance).post(route(group)).send(input())).status).toBe(401);
  expect(
    (
      await request(instance)
        .post(route(group))
        .set('x-operator', 'yes')
        .set('Origin', 'https://elsewhere.invalid')
        .send(input())
    ).status,
  ).toBe(403);
  expect(store.getSessionCollaboration(group)).toBeNull();
});

it('refuses an unavailable fresh source without recording an empty collaboration', async () => {
  const group = randomUUID();
  store.hideSession('ordinary-source');
  const response = await request(app()).post(route(group)).set('x-operator', 'yes').send(input());
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('unavailable_recipient');
  expect(store.getSessionCollaboration(group)).toBeNull();
});
