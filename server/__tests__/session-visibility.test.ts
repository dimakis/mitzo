import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { createSessionVisibilityRouter } from '../session-visibility.js';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const events = new EventStore(':memory:');
  stores.push(events);
  events.upsertSession({ sessionId: 'c', summary: 'Finished work', conversationSource: 'mitzo' });
  events.append('c', 'message_end', { messageId: 'reply' });
  const changed = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions',
    createSessionVisibilityRouter({
      events,
      changed,
      authorize: (_req, _res, next) => next(),
    }),
  );
  return { app, events, changed };
}
it('hides and restores a chat without removing history or creating a removal operation', async () => {
  const f = fixture();
  const before = f.events.getSessionEvents('c');
  await request(f.app).post('/api/sessions/c/visibility').send({ hidden: true }).expect(200);
  expect(f.events.isSessionHidden('c')).toBe(true);
  expect(f.events.removals.read('c')).toBeUndefined();
  const hidden = await request(f.app).get('/api/sessions/hidden').expect(200);
  expect(hidden.body.sessions).toEqual([
    expect.objectContaining({ id: 'c', summary: 'Finished work' }),
  ]);
  await request(f.app).post('/api/sessions/c/visibility').send({ hidden: false }).expect(200);
  expect(f.events.isSessionHidden('c')).toBe(false);
  expect(f.events.getSessionEvents('c')).toEqual(before);
  expect(f.changed).toHaveBeenCalledTimes(2);
});
it('requires same-origin JSON and refuses missing or malformed chat mutations', async () => {
  const f = fixture();
  await request(f.app)
    .post('/api/sessions/c/visibility')
    .set('Origin', 'https://elsewhere.test')
    .send({ hidden: true })
    .expect(403);
  await request(f.app).post('/api/sessions/missing/visibility').send({ hidden: false }).expect(404);
  await request(f.app).post('/api/sessions/c/visibility').send({ hidden: 'false' }).expect(400);
  expect(f.events.isSessionHidden('c')).toBe(false);
});
it('keeps released and uncertain removals visible in history without clearing their admission fence', async () => {
  const f = fixture();
  f.events.hideSession('c');
  f.events.removals.begin('c', 'release', 'fingerprint');
  f.events.removals.markPrepared('c', 'release');
  f.events.removals.transition('c', 'release', 'closing', 'releasing');
  await request(f.app).post('/api/sessions/c/visibility').send({ hidden: false }).expect(409);
  expect(f.events.isSessionHidden('c')).toBe(true);
  f.events.removals.transition('c', 'release', 'releasing', 'completed');
  const hidden = await request(f.app).get('/api/sessions/hidden').expect(200);
  expect(hidden.body.sessions[0].resourcesReleased).toBe(true);
  await request(f.app).post('/api/sessions/c/visibility').send({ hidden: false }).expect(409);
  expect(() => f.events.removals.assertAdmissible('c')).toThrow();
});
it('paginates hidden history and excludes visible chats', async () => {
  const f = fixture();
  for (const id of ['a', 'b']) {
    f.events.upsertSession({ sessionId: id, summary: id, conversationSource: 'mitzo' });
    f.events.hideSession(id);
  }
  const first = await request(f.app).get('/api/sessions/hidden?limit=1').expect(200);
  const second = await request(f.app).get('/api/sessions/hidden?limit=1&offset=1').expect(200);
  expect(first.body.hasMore).toBe(true);
  expect(second.body.hasMore).toBe(false);
  expect(new Set([first.body.sessions[0].id, second.body.sessions[0].id])).toEqual(
    new Set(['a', 'b']),
  );
});
