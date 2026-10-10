import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextPackStore } from '../context-pack-store.js';
import { createContextPackRouter } from '../context-pack-router.js';
import { revokeAuthSession } from '../auth.js';
const stores: ContextPackStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
const definition = {
  version: 1,
  id: 'core',
  name: 'Core',
  description: 'Shared',
  tokenBudget: 4000,
  documents: [
    {
      path: 'architecture/core.md',
      revision: 'a'.repeat(40),
      mode: 'required',
      headings: [['Core']],
      priority: 100,
    },
  ],
  retrievalGuidance: '',
};
function fixture(read = vi.fn(async () => ({ content: '# Core\nAccepted instructions' }))) {
  const store = new ContextPackStore(':memory:');
  stores.push(store);
  const auth = { id: crypto.randomUUID(), expiresAt: Date.now() + 60000 };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('x-operator') === 'yes') res.locals.authSession = auth;
    next();
  });
  app.use(
    '/api/context-packs',
    createContextPackRouter(async () => ({
      store,
      source: { read },
      impact: async () => [{ profileId: 'agent', name: 'Agent', revision: 1, packRevision: 1 }],
      preview: async () => ({ fullMarkdown: 'preview' }),
    })),
  );
  return { app, store, read, auth };
}
it('requires operator authority and denies cross-origin mutation', async () => {
  const { app } = fixture();
  expect((await request(app).get('/api/context-packs')).status).toBe(401);
  expect(
    (
      await request(app)
        .post('/api/context-packs/drafts')
        .set('x-operator', 'yes')
        .set('origin', 'https://evil.example')
        .send({ definition })
    ).status,
  ).toBe(403);
});
it('publishes accepted references, permits direct curation and preserves exact revision pins', async () => {
  const { app, read } = fixture();
  const created = await request(app)
    .post('/api/context-packs/drafts')
    .set('x-operator', 'yes')
    .send({ definition });
  expect(created.status).toBe(201);
  const id = created.body.draft.id;
  expect(
    (
      await request(app)
        .post(`/api/context-packs/drafts/${id}/preview`)
        .set('x-operator', 'yes')
        .send({ version: 1 })
    ).body.compiledContext.fullMarkdown,
  ).toBe('preview');
  const published = await request(app)
    .post(`/api/context-packs/drafts/${id}/publish`)
    .set('x-operator', 'yes')
    .send({ version: 1 });
  expect(published.status).toBe(201);
  expect(read).toHaveBeenCalledWith(
    'architecture/core.md',
    'a'.repeat(40),
    expect.any(AbortSignal),
  );
  expect(
    (await request(app).get('/api/context-packs/core/revisions/1').set('x-operator', 'yes')).body
      .pack,
  ).toEqual(published.body.pack);
  expect(
    (await request(app).get('/api/context-packs/core/impact').set('x-operator', 'yes')).body
      .profiles,
  ).toHaveLength(1);
});
it('retains draft on missing source, missing selector, stale save or revoked authorization', async () => {
  const { app, store } = fixture();
  const d = store.create({
    ...definition,
    version: 1,
    documents: [{ ...definition.documents[0], mode: 'required', headings: [['Missing']] }],
  } as Parameters<ContextPackStore['create']>[0]);
  expect(
    (
      await request(app)
        .post(`/api/context-packs/drafts/${d.id}/publish`)
        .set('x-operator', 'yes')
        .send({ version: 1 })
    ).status,
  ).toBe(422);
  expect(store.getDraft(d.id).state).toBe('draft');
  expect(
    (
      await request(app)
        .put(`/api/context-packs/drafts/${d.id}`)
        .set('x-operator', 'yes')
        .send({ version: 2, definition })
    ).status,
  ).toBe(409);
  const revoked = fixture(
    vi.fn(async () => {
      revokeAuthSession(revoked.auth);
      return { content: '# Core\nAccepted' };
    }),
  );
  const rd = revoked.store.create(definition as Parameters<ContextPackStore['create']>[0]);
  expect(
    (
      await request(revoked.app)
        .post(`/api/context-packs/drafts/${rd.id}/publish`)
        .set('x-operator', 'yes')
        .send({ version: 1 })
    ).status,
  ).toBe(403);
  expect(revoked.store.getDraft(rd.id).state).toBe('draft');
});
it('rejects unaccepted sources before creating reusable publication', async () => {
  const { app, store } = fixture(
    vi.fn(async () => {
      throw new Error('not accepted');
    }),
  );
  const d = store.create(definition as Parameters<ContextPackStore['create']>[0]);
  expect(
    (
      await request(app)
        .post(`/api/context-packs/drafts/${d.id}/publish`)
        .set('x-operator', 'yes')
        .send({ version: 1 })
    ).status,
  ).toBe(422);
  expect(store.list().packs).toEqual([]);
});
it('blocks publication when compilation fails and retains oversized linked-source drafts', async () => {
  const { app, store } = fixture(vi.fn(async () => ({ content: '# Core\n' + 'a'.repeat(65536) })));
  const draft = store.create(definition as Parameters<ContextPackStore['create']>[0]);
  expect(
    (
      await request(app)
        .post(`/api/context-packs/drafts/${draft.id}/publish`)
        .set('x-operator', 'yes')
        .send({ version: 1 })
    ).status,
  ).toBe(422);
  expect(store.list().packs).toHaveLength(0);
  const failing = fixture();
  const f = failing.store.create(definition as Parameters<ContextPackStore['create']>[0]);
  const appFail = express();
  appFail.use(express.json());
  appFail.use((_req, res, next) => {
    res.locals.authSession = failing.auth;
    next();
  });
  appFail.use(
    '/api/context-packs',
    createContextPackRouter(async () => ({
      store: failing.store,
      source: { read: failing.read },
      preview: async () => {
        throw new Error('required content exceeds budget');
      },
    })),
  );
  expect(
    (await request(appFail).post(`/api/context-packs/drafts/${f.id}/publish`).send({ version: 1 }))
      .status,
  ).toBe(422);
  expect(failing.store.getDraft(f.id).state).toBe('draft');
});
