import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../knowledge-draft-store.js';
import {
  createKnowledgeLibraryRouter,
  type KnowledgeLibraryDependencies,
} from '../knowledge-library-router.js';
import { revokeAuthSession } from '../auth.js';
import type { KnowledgeGithubPublisher } from '../knowledge-github-publisher.js';
import type { KnowledgeReviewService } from '../knowledge-review-service.js';

let root: string, store: KnowledgeDraftStore, source: AcceptedKnowledgeSource;
let auth: { id: string; expiresAt: number };
function git(...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-library-api-'));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  mkdirSync(join(root, 'architecture'));
  writeFileSync(join(root, 'architecture/one.md'), '# Accepted\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  source = new AcceptedKnowledgeSource(root, 'refs/remotes/origin/main', ['architecture']);
  store = new KnowledgeDraftStore(join(root, 'drafts.sqlite'));
  auth = { id: root, expiresAt: Date.now() + 60_000 };
});
afterEach(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});
function app(
  runtime: () => Promise<KnowledgeLibraryDependencies | undefined> = async () => ({
    source,
    store,
    syncedAt: null,
    acceptanceEnabled: false,
    refresh: vi.fn(),
  }),
) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    if (req.header('x-operator') === 'yes') res.locals.authSession = auth;
    next();
  });
  a.use('/api/knowledge', createKnowledgeLibraryRouter(runtime));
  return a;
}
it('requires interactive authority, private responses and rejects cross-origin saves', async () => {
  const a = app();
  expect((await request(a).get('/api/knowledge').set('x-internal-token', 'agent')).status).toBe(
    401,
  );
  const catalog = await request(a).get('/api/knowledge').set('x-operator', 'yes');
  expect(catalog.status).toBe(200);
  expect(catalog.headers['cache-control']).toBe('no-store');
  expect(catalog.body.documents).toHaveLength(1);
  expect(
    (
      await request(a)
        .post('/api/knowledge/drafts')
        .set('x-operator', 'yes')
        .set('origin', 'https://evil.example')
        .send({})
    ).status,
  ).toBe(403);
});
it('stores bases on the server and keeps drafts durable even when review is unavailable', async () => {
  const a = app();
  const revision = await source.revision();
  const created = await request(a)
    .post('/api/knowledge/drafts')
    .set('x-operator', 'yes')
    .send({
      title: 'Change',
      baseRevision: revision,
      documents: [{ path: 'architecture/one.md', content: '# Draft\n' }],
    });
  expect(created.status).toBe(201);
  const d = created.body.draft;
  expect(d.documents[0].base).toBe('# Accepted\n');
  const saved = await request(a)
    .put(`/api/knowledge/drafts/${d.id}`)
    .set('x-operator', 'yes')
    .send({ version: 1, documents: [{ path: 'architecture/one.md', content: '# Saved\n' }] });
  expect(saved.status).toBe(200);
  expect(saved.body.draft.documents[0].content).toBe('# Saved\n');
  expect(saved.body.reviewError).toContain('not configured');
  expect(
    (
      await request(a)
        .put(`/api/knowledge/drafts/${d.id}`)
        .set('x-operator', 'yes')
        .send({ version: 1, documents: [{ path: 'architecture/one.md', content: '# Stale\n' }] })
    ).status,
  ).toBe(409);
  expect(store.get(d.id).documents[0]?.content).toBe('# Saved\n');
  expect(git('show', 'HEAD:architecture/one.md')).toBe('# Accepted');
});
it('validates scope before creating a draft and permits explicit conflict resolution against current accepted content', async () => {
  const a = app();
  const revision = await source.revision();
  expect(
    (
      await request(a)
        .post('/api/knowledge/drafts')
        .set('x-operator', 'yes')
        .send({
          title: 'Bad',
          baseRevision: revision,
          documents: [{ path: '../private.md', content: 'secret' }],
        })
    ).status,
  ).toBe(400);
  expect(store.list()).toHaveLength(0);
  const d = store.create('Change', revision, [
    { path: 'architecture/one.md', base: '# Accepted\n', content: '# My edit\n' },
  ]);
  writeFileSync(join(root, 'architecture/one.md'), '# New accepted\n');
  git('add', 'architecture/one.md');
  git('commit', '-m', 'new');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const next = await source.revision();
  const response = await request(a)
    .put(`/api/knowledge/drafts/${d.id}`)
    .set('x-operator', 'yes')
    .send({
      version: d.version,
      baseRevision: next,
      documents: [{ path: 'architecture/one.md', content: '# Resolved\n' }],
    });
  expect(response.status).toBe(200);
  expect(response.body.draft.baseRevision).toBe(next);
  expect(response.body.draft.documents[0].base).toBe('# New accepted\n');
});
it('fences revoked authentication after slow source initialization', async () => {
  let finish!: (value: unknown) => void;
  const a = app(
    () =>
      new Promise((resolve) => {
        finish = (value) => resolve(value as KnowledgeLibraryDependencies);
      }),
  );
  const response = request(a)
    .get('/api/knowledge')
    .set('x-operator', 'yes')
    .then((r) => r);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  revokeAuthSession(auth);
  finish({ source, store, syncedAt: null, acceptanceEnabled: false, refresh: vi.fn() });
  expect((await response).status).toBe(403);
});

it('requires a confirmed ready receipt before accepting the exact saved review', async () => {
  const revision = await source.revision();
  const draft = store.create('Change', revision, [
    { path: 'architecture/one.md', base: '# Accepted\n', content: '# Draft\n' },
  ]);
  const head = 'a'.repeat(40);
  const receipt = { url: 'https://github.com/test/knowledge/pull/1', head };
  store.receipt(draft.id, draft.version, receipt);
  const accept = vi.fn(async () => undefined);
  const a = app(async () => ({
    source,
    store,
    syncedAt: null,
    acceptanceEnabled: true,
    refresh: vi.fn(),
    reviewService: {
      config: { repository: 'test/knowledge', baseBranch: 'main' },
      assertIdle: (id: string) => store.assertIdle(id),
    } as unknown as KnowledgeReviewService,
    publisher: { accept } as unknown as KnowledgeGithubPublisher,
  }));
  const perform = () =>
    request(a)
      .post(`/api/knowledge/drafts/${draft.id}/accept`)
      .set('x-operator', 'yes')
      .send({ version: draft.version, head });
  expect((await perform()).status).toBe(409);
  expect(accept).not.toHaveBeenCalled();
  expect(store.get(draft.id).state).toBe('in-review');
  store.receipt(draft.id, draft.version, { ...receipt, ready: true });
  expect((await perform()).status).toBe(200);
  expect(accept).toHaveBeenCalledOnce();
  expect(store.get(draft.id).state).toBe('accepted');
});

it('sends only the current saved review for review and preserves its source', async () => {
  const revision = await source.revision();
  const draft = store.create('Change', revision, [
    { path: 'architecture/one.md', base: '# Accepted\n', content: '# My draft\n' },
  ]);
  const head = 'a'.repeat(40);
  store.receipt(draft.id, draft.version, { url: 'https://github.com/test/knowledge/pull/1', head });
  const sendForReview = vi.fn(async () => ({
    state: 'in-review',
    head,
    draft: false,
    canAccept: false,
  }));
  const a = app(async () => ({
    source,
    store,
    syncedAt: null,
    acceptanceEnabled: false,
    refresh: vi.fn(),
    reviewService: {
      config: { repository: 'test/knowledge', baseBranch: 'main' },
      assertIdle: (id: string) => store.assertIdle(id),
    } as unknown as KnowledgeReviewService,
    publisher: { sendForReview } as unknown as KnowledgeGithubPublisher,
  }));
  expect(
    (
      await request(a)
        .post(`/api/knowledge/drafts/${draft.id}/ready`)
        .set('x-operator', 'yes')
        .send({ version: draft.version, head: 'b'.repeat(40) })
    ).status,
  ).toBe(409);
  expect(sendForReview).not.toHaveBeenCalled();
  const response = await request(a)
    .post(`/api/knowledge/drafts/${draft.id}/ready`)
    .set('x-operator', 'yes')
    .send({ version: draft.version, head });
  expect(response.status).toBe(200);
  expect(response.body.draft.review.ready).toBe(true);
  expect(response.body.draft.documents[0].content).toBe('# My draft\n');
  expect(
    store.save(draft.id, draft.version, [
      { path: 'architecture/one.md', base: '# Accepted\n', content: '# Next edit\n' },
    ]).version,
  ).toBe(2);
});

it('captures move bases from accepted original paths and persists new folders', async () => {
  const created = await request(app())
    .post('/api/knowledge/drafts')
    .set('x-operator', 'yes')
    .send({
      title: 'Organize',
      baseRevision: await source.revision(),
      directories: ['architecture/new'],
      documents: [
        {
          path: 'architecture/new/one.md',
          sourcePath: 'architecture/one.md',
          content: '# Accepted\n',
        },
      ],
    });
  expect(created.status).toBe(201);
  expect(created.body.draft.documents[0]).toEqual({
    path: 'architecture/new/one.md',
    sourcePath: 'architecture/one.md',
    base: '# Accepted\n',
    content: '# Accepted\n',
  });
  const saved = await request(app())
    .put('/api/knowledge/drafts/' + created.body.draft.id)
    .set('x-operator', 'yes')
    .send({
      version: 1,
      documents: [{ path: 'architecture/one.md', content: '# Accepted\n' }],
      directories: [],
    });
  expect(saved.status).toBe(200);
  expect(saved.body.draft.documents[0].sourcePath).toBeUndefined();
});
it('allows folder-only drafts while rejecting root and uncurated folders', async () => {
  for (const folder of [
    'new',
    'architecture',
    'scripts/new',
    'architecture/../outside',
    'architecture/.secret',
  ]) {
    const result = await request(app())
      .post('/api/knowledge/drafts')
      .set('x-operator', 'yes')
      .send({
        title: 'Folder',
        baseRevision: await source.revision(),
        documents: [],
        directories: [folder],
      });
    expect(result.status).not.toBe(201);
  }
  const result = await request(app())
    .post('/api/knowledge/drafts')
    .set('x-operator', 'yes')
    .send({
      title: 'Folder',
      baseRevision: await source.revision(),
      documents: [],
      directories: ['architecture/new'],
    });
  expect(result.status).toBe(201);
});
