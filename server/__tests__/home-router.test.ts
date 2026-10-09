import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHomeRouter } from '../home-router.js';
import { HomeStore } from '../home-store.js';
import { compileQuoteCatalog } from '../quote-catalog.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-home-api-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
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
function app(changed = vi.fn()) {
  const app = express();
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
  return app;
}
it('validates writes and reports stale device edits without overwriting preferences', async () => {
  const api = app();
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
  const api = app(changed);
  await request(api).put('/api/home/preferences').send({ revision: 0, pins: [] });
  expect(changed).toHaveBeenCalledTimes(1);
  await request(api).put('/api/home/preferences').send({ revision: 0, pins: [] });
  expect(changed).toHaveBeenCalledTimes(1);
});
it('keeps a durable preference write successful when notification delivery fails', async () => {
  const api = app(
    vi.fn(() => {
      throw new Error('Notification unavailable');
    }),
  );
  const errors: unknown[] = [];
  api.use(
    (
      error: unknown,
      _req: express.Request,
      _res: express.Response,
      _next: express.NextFunction,
    ) => {
      errors.push(error);
    },
  );
  const saved = await request(api)
    .put('/api/home/preferences')
    .send({ revision: 0, names: { briefing: 'Jeeves' } });
  expect(saved.status).toBe(200);
  expect(errors).toEqual([]);
  expect((await request(api).get('/api/home/preferences')).body.names.briefing).toBe('Jeeves');
});
it('registers only actual session account/model bindings and returns exact report conversations', async () => {
  const api = app();
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
it('serves the cached daily quote and saved briefing, with explicit missing and invalid states', async () => {
  const api = app();
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
