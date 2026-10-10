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
  expect(saved.body.reviewError).toBeUndefined();
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
      sendForReview: async (id: string, version: number) => {
        await sendForReview();
        return store.receipt(id, version, {
          url: 'https://github.com/test/knowledge/pull/1',
          head,
          ready: true,
        });
      },
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

it('distinguishes authoritative missing drafts from storage failure and expired authority', async () => {
  const path = '/api/knowledge/drafts/12345678-1234-4123-8123-123456789abc';
  const missing = await request(app()).get(path).set('x-operator', 'yes');
  expect(missing.status).toBe(404);
  expect(missing.body.error).toBe('Draft not found');
  const failed = vi.spyOn(store, 'get').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  expect((await request(app()).get(path).set('x-operator', 'yes')).status).toBe(422);
  failed.mockRestore();
  expect((await request(app()).get(path)).status).toBe(401);
  const revoked = app(async () => {
    revokeAuthSession(auth);
    return { source, store, syncedAt: null, acceptanceEnabled: false, refresh: vi.fn() };
  });
  expect((await request(revoked).get(path).set('x-operator', 'yes')).status).toBe(403);
});

it('cancels a sole saved folder with a current version, review identity and exclusive lease', async () => {
  const draft = store.create('Folder', await source.revision(), [], undefined, [
    'architecture/new',
  ]);
  const head = 'a'.repeat(40);
  store.receipt(draft.id, draft.version, { url: 'https://github.com/test/knowledge/pull/1', head });
  const cancel = vi.fn(async (identity) => {
    expect(identity).toMatchObject({
      draftId: draft.id,
      head,
      repository: 'test/knowledge',
      baseBranch: 'main',
    });
    expect(() =>
      store.save(draft.id, draft.version, [], undefined, ['architecture/other']),
    ).toThrow('saving its review');
    return { state: 'closed', head, canAccept: false };
  });
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
    publisher: { cancel } as unknown as KnowledgeGithubPublisher,
  }));
  const endpoint = '/api/knowledge/drafts/' + draft.id + '/cancel';
  expect(
    (await request(a).post(endpoint).set('x-operator', 'yes').send({ version: 2 })).status,
  ).toBe(409);
  expect(cancel).not.toHaveBeenCalled();
  const response = await request(a).post(endpoint).set('x-operator', 'yes').send({ version: 1 });
  expect(response.status).toBe(200);
  expect(response.body.draft).toMatchObject({
    state: 'closed',
    version: 1,
    documents: [],
    directories: ['architecture/new'],
  });
  const retry = await request(a).post(endpoint).set('x-operator', 'yes').send({ version: 1 });
  expect(retry.body.draft).toEqual(response.body.draft);
  expect(cancel).toHaveBeenCalledOnce();
});
it('preserves folder and review copies on ambiguous or mismatching close responses', async () => {
  const draft = store.create('Folder', await source.revision(), [], undefined, [
    'architecture/new',
  ]);
  const head = 'a'.repeat(40);
  store.receipt(draft.id, draft.version, { url: 'https://github.com/test/knowledge/pull/1', head });
  const cancel = vi
    .fn()
    .mockRejectedValueOnce(new Error('Lost close response'))
    .mockResolvedValueOnce({ state: 'accepted', head })
    .mockResolvedValueOnce({ state: 'closed', head: 'b'.repeat(40) })
    .mockResolvedValue({ state: 'closed', head, canAccept: false });
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
    publisher: { cancel } as unknown as KnowledgeGithubPublisher,
  }));
  const perform = () =>
    request(a)
      .post('/api/knowledge/drafts/' + draft.id + '/cancel')
      .set('x-operator', 'yes')
      .send({ version: 1 });
  for (let i = 0; i < 3; i++) {
    expect((await perform()).status).not.toBe(200);
    expect(store.get(draft.id)).toMatchObject({
      state: 'in-review',
      version: 1,
      directories: ['architecture/new'],
    });
    store.assertIdle(draft.id);
  }
  expect((await perform()).body.draft.state).toBe('closed');
});
it('cancels never-published folders locally but refuses ambiguous prepared and finished changes', async () => {
  const local = store.create('Local', await source.revision(), [], undefined, [
    'architecture/local',
  ]);
  const a = app();
  const cancel = (id: string, version: number) =>
    request(a)
      .post('/api/knowledge/drafts/' + id + '/cancel')
      .set('x-operator', 'yes')
      .send({ version });
  expect((await cancel(local.id, 1)).body.draft).toMatchObject({
    state: 'closed',
    directories: ['architecture/local'],
  });
  const uncertain = store.create('Uncertain', await source.revision(), [], undefined, [
    'architecture/uncertain',
  ]);
  store.prepared(uncertain.id, 1, 'a'.repeat(40));
  expect((await cancel(uncertain.id, 1)).status).toBe(409);
  expect(store.get(uncertain.id).state).toBe('draft');
  const accepted = store.create('Accepted', await source.revision(), [], undefined, [
    'architecture/accepted',
  ]);
  store.status(accepted.id, 'accepted');
  expect((await cancel(accepted.id, 1)).status).toBe(409);
});

it('refuses cancellation of an older saved review or a mismatching prepared head', async () => {
  const draft = store.create('Folder', await source.revision(), [], undefined, [
    'architecture/new',
  ]);
  const head = 'a'.repeat(40);
  store.receipt(draft.id, 1, { url: 'https://github.com/test/knowledge/pull/1', head });
  const cancel = vi.fn();
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
    publisher: { cancel } as unknown as KnowledgeGithubPublisher,
  }));
  const perform = (version: number) =>
    request(a)
      .post('/api/knowledge/drafts/' + draft.id + '/cancel')
      .set('x-operator', 'yes')
      .send({ version });
  store.prepared(draft.id, 1, 'b'.repeat(40));
  expect((await perform(1)).status).toBe(409);
  store.save(draft.id, 1, [], undefined, ['architecture/changed']);
  expect((await perform(2)).status).toBe(409);
  expect(cancel).not.toHaveBeenCalled();
  expect(store.get(draft.id)).toMatchObject({
    state: 'draft',
    version: 2,
    directories: ['architecture/changed'],
  });
});
it('blocks remote close after the cancellation lease expires during inspection', async () => {
  auth.expiresAt = Date.now() + 3600000;
  const draft = store.create('Folder', await source.revision(), [], undefined, [
    'architecture/new',
  ]);
  const head = 'a'.repeat(40);
  store.receipt(draft.id, 1, { url: 'https://github.com/test/knowledge/pull/1', head });
  const now = Date.now();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  let remoteClosed = false;
  const cancel = vi.fn(async (identity) => {
    clock = vi.spyOn(Date, 'now').mockReturnValue(now + 181000);
    store.save(draft.id, 1, [], undefined, ['architecture/newer']);
    identity.beforeClose();
    remoteClosed = true;
    return { state: 'closed', head, canAccept: false };
  });
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
    publisher: { cancel } as unknown as KnowledgeGithubPublisher,
  }));
  try {
    const response = await request(a)
      .post('/api/knowledge/drafts/' + draft.id + '/cancel')
      .set('x-operator', 'yes')
      .send({ version: 1 });
    expect(response.status).toBe(409);
    expect(remoteClosed).toBe(false);
    expect(store.get(draft.id)).toMatchObject({
      state: 'draft',
      version: 2,
      directories: ['architecture/newer'],
    });
  } finally {
    clock?.mockRestore();
  }
});

it.each([
  ['draft', false],
  ['draft', true],
  ['in-review', false],
  ['in-review', true],
  ['closed', false],
  ['closed', true],
] as const)(
  'restricts folder cancellation before any mutation for %s document drafts (folders: %s)',
  async (state, withFolders) => {
    const draft = store.create(
      'Document change',
      await source.revision(),
      [
        {
          path: 'architecture/one.md',
          base: '# Accepted\n',
          content: '# Edited\n',
        },
      ],
      undefined,
      withFolders ? ['architecture/new'] : [],
    );
    const head = 'a'.repeat(40);
    if (state !== 'draft')
      store.receipt(draft.id, 1, { url: 'https://github.com/test/knowledge/pull/1', head });
    if (state === 'closed') store.status(draft.id, 'closed');
    const original = store.get(draft.id);
    const cancel = vi.fn(async () => ({ state: 'closed', head, canAccept: false }));
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
      publisher: { cancel } as unknown as KnowledgeGithubPublisher,
    }));
    const response = await request(a)
      .post('/api/knowledge/drafts/' + draft.id + '/cancel')
      .set('x-operator', 'yes')
      .send({ version: 1 });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(
      'Only folder-only changes can be cancelled through this action.',
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(store.get(draft.id)).toEqual(original);
  },
);

it('keeps Save and the legacy review request local without refreshing or publishing', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Accepted\n', content: '# First\n' },
  ]);
  const submit = vi.fn();
  const sendForReview = vi.fn();
  const refresh = vi.fn();
  const publisher = {
    identity: vi.fn(),
    read: vi.fn(),
    readBranch: vi.fn(),
    push: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    sendForReview: vi.fn(),
  };
  const a = app(async () => ({
    source,
    store,
    syncedAt: null,
    acceptanceEnabled: false,
    refresh,
    reviewService: {
      submit,
      sendForReview,
      assertIdle: (id: string) => store.assertIdle(id),
    } as unknown as KnowledgeReviewService,
    publisher: publisher as unknown as KnowledgeGithubPublisher,
  }));
  const saved = await request(a)
    .put('/api/knowledge/drafts/' + draft.id)
    .set('x-operator', 'yes')
    .send({ version: 1, documents: [{ path: 'architecture/one.md', content: '# Second\n' }] });
  expect(saved.status).toBe(200);
  expect(saved.body.draft).toMatchObject({ state: 'draft', version: 2 });
  expect(saved.body.reviewError).toBeUndefined();
  expect(
    (
      await request(a)
        .post('/api/knowledge/drafts/' + draft.id + '/review')
        .set('x-operator', 'yes')
        .send({ version: 2 })
    ).body.draft,
  ).toEqual(saved.body.draft);
  expect(
    (
      await request(a)
        .post('/api/knowledge/drafts/' + draft.id + '/review')
        .set('x-operator', 'yes')
        .send({ version: 1 })
    ).status,
  ).toBe(409);
  expect(submit).not.toHaveBeenCalled();
  expect(sendForReview).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  for (const call of Object.values(publisher)) expect(call).not.toHaveBeenCalled();
});
it('sends a saved batch without a client-selected head and retains the legacy expected-head fence', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Accepted\n', content: '# First\n' },
  ]);
  const head = 'a'.repeat(40);
  const sendForReview = vi.fn(async (id: string, version: number) =>
    store.receipt(id, version, {
      url: 'https://github.com/test/knowledge/pull/1',
      head,
      ready: true,
    }),
  );
  const a = app(async () => ({
    source,
    store,
    syncedAt: null,
    acceptanceEnabled: false,
    refresh: vi.fn(),
    reviewService: {
      sendForReview,
      assertIdle: (id: string) => store.assertIdle(id),
    } as unknown as KnowledgeReviewService,
    publisher: {} as KnowledgeGithubPublisher,
  }));
  const endpoint = '/api/knowledge/drafts/' + draft.id + '/ready';
  expect(
    (await request(a).post(endpoint).set('x-operator', 'yes').send({ version: 1, head })).status,
  ).toBe(409);
  expect(sendForReview).not.toHaveBeenCalled();
  const sent = await request(a).post(endpoint).set('x-operator', 'yes').send({ version: 1 });
  expect(sent.status).toBe(200);
  expect(sent.body.draft.review).toMatchObject({ head, version: 1, ready: true });
  expect(
    (
      await request(a)
        .post(endpoint)
        .set('x-operator', 'yes')
        .send({ version: 1, head: 'b'.repeat(40) })
    ).status,
  ).toBe(409);
});
it('staging a newer version retains the old ready review and blocks accepting it', async () => {
  const draft = store.create('Batch', await source.revision(), [
    { path: 'architecture/one.md', base: '# Accepted\n', content: '# First\n' },
  ]);
  const head = 'a'.repeat(40);
  store.receipt(draft.id, 1, {
    url: 'https://github.com/test/knowledge/pull/1',
    head,
    ready: true,
  });
  const accept = vi.fn();
  const submit = vi.fn();
  const a = app(async () => ({
    source,
    store,
    syncedAt: null,
    acceptanceEnabled: true,
    refresh: vi.fn(),
    reviewService: {
      submit,
      assertIdle: (id: string) => store.assertIdle(id),
    } as unknown as KnowledgeReviewService,
    publisher: { accept } as unknown as KnowledgeGithubPublisher,
  }));
  const saved = await request(a)
    .put('/api/knowledge/drafts/' + draft.id)
    .set('x-operator', 'yes')
    .send({ version: 1, documents: [{ path: 'architecture/one.md', content: '# Later\n' }] });
  expect(saved.body.draft).toMatchObject({
    state: 'draft',
    version: 2,
    review: { head, version: 1, ready: true },
  });
  expect(
    (
      await request(a)
        .post('/api/knowledge/drafts/' + draft.id + '/accept')
        .set('x-operator', 'yes')
        .send({ version: 2, head })
    ).status,
  ).toBe(409);
  expect(accept).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});
