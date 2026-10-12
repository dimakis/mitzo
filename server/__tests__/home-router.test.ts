import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHomeRouter } from '../home-router.js';
import { HomeStore } from '../home-store.js';
import { compileQuoteCatalog } from '../quote-catalog.js';
import { EventStore } from '@mitzo/protocol/event-store';

let root: string;
const servers: Server[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-home-api-'));
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = closeTestServer(server);
    server.closeAllConnections();
    await closed;
    expect(server.listening).toBe(false);
  }
  rmSync(root, { recursive: true, force: true });
});
async function ownFixture(app: express.Express): Promise<Server> {
  const server = await listenOnLoopback(app);
  servers.push(server);
  return server;
}
const entry = {
  id: 'epictetus-5',
  text: 'Inspect your judgement.',
  author: 'Epictetus',
  work: 'Enchiridion 5',
  translation: 'Carter',
  explanation: 'A sourced interpretation.',
  example: 'Pause.',
  biography: 'A Stoic.',
  sourceUrl: 'https://classics.mit.edu/Epictetus/epicench.html',
  explainerUrl: 'https://dcc.dickinson.edu/epictetus-encheiridion/chapter-5',
  authorUrl: 'https://plato.stanford.edu/entries/epictetus/',
};
function fixtureRoutes() {
  const routes = express();
  const fixtureRoot = root;
  routes.use((_req, res, next) => {
    res.set('X-Home-Test-Fixture', encodeURIComponent(fixtureRoot));
    next();
  });
  return routes;
}
async function app(changed = vi.fn(), errors?: unknown[]) {
  const app = fixtureRoutes();
  app.use(express.json());
  app.use(
    '/api/home',
    createHomeRouter({
      store: new HomeStore(join(root, 'home.json')),
      catalog: () => [entry],
      changed,
      session: (id) =>
        id === 'registered'
          ? {
              sessionType: 'chat',
              isHidden: false,
              selectedModel: 'luna',
              accountBinding: { accountId: 'work', model: 'luna' },
            }
          : null,
      briefing: (date) =>
        date === '2026-10-10'
          ? {
              date,
              content: '# Saved report',
              revision: 'a'.repeat(64),
              path: '/workspace/report.md',
              filename: 'report.md',
              generatedAt: '2026-10-10T07:00:00Z',
            }
          : null,
    }),
  );
  if (errors) {
    app.use(
      (
        error: unknown,
        _req: express.Request,
        _res: express.Response,
        _next: express.NextFunction,
      ) => {
        errors.push(error);
      },
    );
  }
  return ownFixture(app);
}
it('owns one IPv4 listener across requests and keeps fixture identity observable', async () => {
  const api = await app();
  expect(api.listening).toBe(true);
  expect(api.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  const address = api.address();
  for (let index = 0; index < 20; index++) {
    const response = await request(api).get('/api/home/preferences');
    expect(response.status).toBe(200);
    expect(response.headers['x-home-test-fixture']).toBe(encodeURIComponent(root));
    expect(api.address()).toEqual(address);
  }
});
it('validates writes and reports stale device edits without overwriting preferences', async () => {
  const api = await app();
  expect((await request(api).get('/api/home/preferences')).body.revision).toBe(0);
  expect(
    (
      await request(api)
        .put('/api/home/preferences')
        .send({ revision: 0, names: { briefing: 'Jeeves' } })
    ).status,
  ).toBe(200);
  expect(
    (await request(api).put('/api/home/preferences').send({ revision: 0, pins: [] })).status,
  ).toBe(409);
  expect(
    (
      await request(api)
        .put('/api/home/preferences')
        .send({ revision: 1, pins: [{ kind: 'url', id: 'evil', title: 'External' }] })
    ).status,
  ).toBe(400);
  expect((await request(api).get('/api/home/preferences')).body.names.briefing).toBe('Jeeves');
});
it('broadcasts saved preferences only after a successful write', async () => {
  const changed = vi.fn();
  const api = await app(changed);
  await request(api).put('/api/home/preferences').send({ revision: 0, pins: [] });
  expect(changed).toHaveBeenCalledTimes(1);
  await request(api).put('/api/home/preferences').send({ revision: 0, pins: [] });
  expect(changed).toHaveBeenCalledTimes(1);
});
it('keeps a durable preference write successful when notification delivery fails', async () => {
  const errors: unknown[] = [];
  const api = await app(
    vi.fn(() => {
      throw new Error('Notification unavailable');
    }),
    errors,
  );
  const saved = await request(api)
    .put('/api/home/preferences')
    .send({ revision: 0, names: { briefing: 'Jeeves' } });
  expect(saved.status).toBe(200);
  expect(errors).toEqual([]);
  expect((await request(api).get('/api/home/preferences')).body.names.briefing).toBe('Jeeves');
});
it('registers only actual session account/model bindings and returns exact report conversations', async () => {
  const api = await app();
  const binding = {
    date: '2026-10-10',
    revision: 'a'.repeat(64),
    sessionId: 'registered',
    accountId: 'work',
    model: 'luna',
  };
  expect(
    (
      await request(api)
        .post('/api/home/briefing-chats')
        .send({ ...binding, sessionId: 'missing' })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(api)
        .post('/api/home/briefing-chats')
        .send({ ...binding, accountId: 'personal' })
    ).status,
  ).toBe(409);
  expect((await request(api).post('/api/home/briefing-chats').send(binding)).status).toBe(201);
  expect((await request(api).post('/api/home/briefing-chats').send(binding)).status).toBe(201);
  const query = `/api/home/briefing-chats?date=${binding.date}&revision=${binding.revision}`;
  expect((await request(api).get(query)).body).toEqual([expect.objectContaining(binding)]);
  expect((await request(api).get('/api/home/briefing-chats?sessionId=registered')).body).toEqual([
    expect.objectContaining(binding),
  ]);
  expect((await request(api).get('/api/home/briefing-chats?sessionId=missing')).body).toEqual([]);
  expect((await request(api).get('/api/home/briefing-chats?sessionId=..%2Fescape')).status).toBe(
    400,
  );
  expect((await request(api).get(query.replace(binding.revision, 'b'.repeat(64)))).body).toEqual(
    [],
  );
  expect(
    (await request(api).get('/api/home/briefing-chats?date=2026-02-30&revision=bad')).status,
  ).toBe(400);
});

it('does not reuse or register a deleted briefing chat while preserving its saved history', async () => {
  const sessions = new EventStore(':memory:');
  const store = new HomeStore(join(root, 'home.json'));
  const routes = fixtureRoutes();
  routes.use(express.json());
  routes.use(
    '/api/home',
    createHomeRouter({
      store,
      catalog: () => [entry],
      briefing: () => null,
      session: (id) => sessions.getSession(id),
    }),
  );
  // The real DELETE route hides the row; the EventStore deliberately retains its metadata.
  routes.delete('/api/sessions/:id', (req, res) => {
    sessions.hideSession(req.params.id);
    res.sendStatus(204);
  });
  const api = await ownFixture(routes);
  const selection = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai',
    model: 'luna',
    profileRevision: 'fixture',
  };
  const binding = {
    date: '2026-10-10',
    revision: 'a'.repeat(64),
    sessionId: 'deleted-chat',
    accountId: 'work',
    model: 'luna',
  };
  try {
    sessions.upsertSession({ sessionId: binding.sessionId, accountBinding: selection });
    expect((await request(api).post('/api/home/briefing-chats').send(binding)).status).toBe(201);
    const dateQuery = `/api/home/briefing-chats?date=${binding.date}&revision=${binding.revision}`;
    expect((await request(api).get(dateQuery)).body).toHaveLength(1);
    expect((await request(api).delete(`/api/sessions/${binding.sessionId}`)).status).toBe(204);
    expect(sessions.getSession(binding.sessionId)?.isHidden).toBe(true);
    expect((await request(api).get(dateQuery)).body).toEqual([]);
    expect(
      (await request(api).get(`/api/home/briefing-chats?sessionId=${binding.sessionId}`)).body,
    ).toEqual([]);
    expect((await request(api).post('/api/home/briefing-chats').send(binding)).status).toBe(404);
    // Asking again finds no resumable binding and can register a new visible conversation.
    sessions.upsertSession({ sessionId: 'fresh-chat', accountBinding: selection });
    expect(
      (
        await request(api)
          .post('/api/home/briefing-chats')
          .send({ ...binding, sessionId: 'fresh-chat' })
      ).status,
    ).toBe(201);
    expect((await request(api).get(dateQuery)).body).toEqual([
      expect.objectContaining({ ...binding, sessionId: 'fresh-chat' }),
    ]);
    expect(store.briefingChats(binding.date, binding.revision)).toHaveLength(2);
    expect(sessions.getSession(binding.sessionId)?.isHidden).toBe(true);
  } finally {
    sessions.close();
  }
});
it('serves the cached daily quote and saved briefing, with explicit missing and invalid states', async () => {
  const api = await app();
  const quote = await request(api).get('/api/home/quote?date=2026-10-10');
  expect(quote.status).toBe(200);
  expect(quote.body.quote.id).toBe(entry.id);
  expect((await request(api).get('/api/home/quote?date=2026-02-30')).status).toBe(400);
  expect((await request(api).get('/api/home/briefing?date=2026-10-10')).body.content).toBe(
    '# Saved report',
  );
  expect((await request(api).get('/api/home/briefing?date=2026-10-09')).status).toBe(404);
});
it('publishes complete verified entries only; drafts, duplicate IDs and unsafe links cannot enter the cache', () => {
  expect(
    compileQuoteCatalog([
      {
        ...entry,
        verification: 'verified',
        evidence: 'Compared the cited passage and translation.',
      },
      { ...entry, id: 'draft', verification: 'draft', evidence: '' },
    ]),
  ).toEqual([entry]);
  expect(() =>
    compileQuoteCatalog([{ ...entry, verification: 'verified', evidence: '' }]),
  ).toThrow();
  expect(() =>
    compileQuoteCatalog([
      { ...entry, sourceUrl: 'javascript:alert(1)', verification: 'verified', evidence: 'checked' },
    ]),
  ).toThrow();
  expect(() => compileQuoteCatalog([1])).toThrow();
});
