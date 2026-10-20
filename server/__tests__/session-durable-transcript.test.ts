import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '@mitzo/client';
import { EventStore } from '../event-store.js';
import {
  authMiddleware,
  COOKIE_NAME,
  login,
  revokeAuthSession,
  authenticateToken,
} from '../auth.js';
import { createSessionMessagesHandler } from '../session-messages-route.js';

let store: EventStore;
beforeEach(() => {
  store = new EventStore(':memory:');
  store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
  store.append('one', 'user_message', {
    messageId: 'original',
    text: 'Visible',
    credential: 'PRIVATE',
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

async function fixture() {
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const auth = (await authenticateToken(token))!;
  const cookie = `${COOKIE_NAME}=${token}`;
  const legacy = {
    getMessages: vi.fn(async () => ['legacy']),
    getSessionTranscript: vi.fn(async () => ({ legacy: true })),
    getReconnectTranscript: vi.fn((_id: string, throughSeq: number) => ({ throughSeq })),
  };
  const read = vi.fn((id: string) => store.getDurableSessionTranscript(id));
  const app = express();
  app.use(cookieParser());
  app.use('/api', authMiddleware);
  app.get(
    '/api/sessions/:id/messages',
    createSessionMessagesHandler({ ...legacy, getDurableSessionTranscript: read }),
  );
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const result = await request(app).get(url).set('Cookie', cookie);
    return new Response(JSON.stringify(result.body), { status: result.status });
  });
  return { app, legacy, read, auth, cookie, transport, api: new MitzoApiClient(transport) };
}

it('connects authenticated HTTP and the actual typed client to the pure EventStore source', async () => {
  const h = await fixture();
  const replay = vi.spyOn(store, 'getSessionEvents').mockImplementation(() => {
    throw Error('Forbidden replay');
  });
  const before = store.listSessions();
  const result = await h.api.getDurableSessionTranscript('one');
  expect(result).toMatchObject({
    sourceConversationId: 'one',
    boundary: { sequence: 1, messageId: 'original' },
    messages: [{ messageId: 'original', blocks: [{ content: 'Visible' }] }],
  });
  expect(h.transport).toHaveBeenCalledWith(
    '/api/sessions/one/messages?transcript=durable',
    expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }),
  );
  expect(h.read).toHaveBeenCalledExactlyOnceWith('one');
  expect(replay).not.toHaveBeenCalled();
  expect(store.listSessions()).toEqual(before);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  for (const owner of Object.values(h.legacy)) expect(owner).not.toHaveBeenCalled();
});

it('keeps real authentication and revocation ahead of the durable source read', async () => {
  const h = await fixture();
  await request(h.app).get('/api/sessions/one/messages?transcript=durable').expect(401);
  expect(h.read).not.toHaveBeenCalled();
  revokeAuthSession(h.auth);
  await request(h.app)
    .get('/api/sessions/one/messages?transcript=durable')
    .set('Cookie', h.cookie)
    .expect(401);
  expect(h.read).not.toHaveBeenCalled();
});

it.each(['throughSeq=1', 'transcript=1', 'transcript=durable', 'transcript[x]=durable', 'extra=1'])(
  'rejects durable query conflict %s before any source or restore calls',
  async (query) => {
    const h = await fixture();
    await request(h.app)
      .get(`/api/sessions/one/messages?transcript=durable&${query}`)
      .set('Cookie', h.cookie)
      .expect(400);
    expect(h.read).not.toHaveBeenCalled();
    for (const owner of Object.values(h.legacy)) expect(owner).not.toHaveBeenCalled();
  },
);

it.each(['absent', 'partial', 'hidden', 'private-error'])(
  'contains %s source failure without private content or restore fallback',
  async (kind) => {
    const h = await fixture();
    if (kind === 'partial') store.append('one', 'message_start', { messageId: 'partial' });
    if (kind === 'hidden') store.hideSession('one');
    if (kind === 'private-error')
      h.read.mockImplementation(() => {
        throw Error('PRIVATE path /secret/provider');
      });
    const result = await request(h.app)
      .get(`/api/sessions/${kind === 'absent' ? 'missing' : 'one'}/messages?transcript=durable`)
      .set('Cookie', h.cookie)
      .expect(500);
    expect(result.body).toEqual({ error: 'Session transcript unavailable' });
    for (const owner of Object.values(h.legacy)) expect(owner).not.toHaveBeenCalled();
  },
);

it('preserves all three existing restore routes and cursor validation unchanged', async () => {
  const h = await fixture();
  expect(
    (await request(h.app).get('/api/sessions/one/messages').set('Cookie', h.cookie).expect(200))
      .body,
  ).toEqual(['legacy']);
  expect(
    (
      await request(h.app)
        .get('/api/sessions/one/messages?transcript=1&throughSeq=7')
        .set('Cookie', h.cookie)
        .expect(200)
    ).body,
  ).toEqual({ legacy: true });
  expect(
    (
      await request(h.app)
        .get('/api/sessions/one/messages?throughSeq=7')
        .set('Cookie', h.cookie)
        .expect(200)
    ).body,
  ).toEqual({ throughSeq: 7 });
  await request(h.app)
    .get('/api/sessions/one/messages?throughSeq=01')
    .set('Cookie', h.cookie)
    .expect(400);
  expect(h.read).not.toHaveBeenCalled();
});

it('preserves exact 512 KiB visible message material through actual store, HTTP and typed client, refusing the next byte', async () => {
  store.append('one', 'user_message', { messageId: 'second', text: '' });
  const empty = store.getDurableSessionTranscript('one');
  const overhead = Buffer.byteLength(JSON.stringify(empty.messages)) - Buffer.byteLength('Visible');
  const second = 512 * 1024 - overhead - 280000;
  function replace(extra: string) {
    store.close();
    store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
    store.append('one', 'user_message', { messageId: 'original', text: 'x'.repeat(280000) });
    store.append('one', 'user_message', { messageId: 'second', text: 'y'.repeat(second) + extra });
  }
  replace('');
  const h = await fixture();
  const result = await h.api.getDurableSessionTranscript('one');
  expect(Buffer.byteLength(JSON.stringify(result.messages))).toBe(512 * 1024);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(512 * 1024);
  replace('z');
  await expect(h.api.getDurableSessionTranscript('one')).rejects.toThrow(
    'API 500: {"error":"Session transcript unavailable"}',
  );
  for (const owner of Object.values(h.legacy)) expect(owner).not.toHaveBeenCalled();
});
