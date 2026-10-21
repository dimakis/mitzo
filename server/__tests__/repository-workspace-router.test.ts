import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createRepositoryWorkspaceRouter } from '../repository-workspace-router.js';
import type { AccountBinding } from '@mitzo/protocol';
import { RepositorySourceLimitError, RepositorySpaceError } from '../github-repository-source.js';

it.each([
  ['preview', false],
  ['prepare', false],
  ['preview', true],
  ['prepare', true],
] as const)(
  'reports a useful preparation error for %s (space=%s) without exposing arbitrary failures',
  async (operation, space) => {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
      next();
    });
    const effect = vi.fn(async () => {
      throw space ? new RepositorySpaceError() : new RepositorySourceLimitError();
    });
    app.use(
      '/repositories',
      createRepositoryWorkspaceRouter({
        resolveBinding: () =>
          ({ accountId: 'account', model: 'model', provider: 'openai' }) as AccountBinding,
        catalog: vi.fn(),
        preview: effect,
        prepare: effect,
      }),
    );
    const path =
      operation === 'preview'
        ? '/repositories/preview'
        : '/repositories/8ca30b0d-3e65-4eeb-8244-f6277350818f/prepare';
    const body = {
      accountId: 'account',
      model: 'model',
      ...(operation === 'preview'
        ? { connectionId: 'connection', repository: 'example/repo' }
        : {}),
    };
    const response = await request(app).post(path).send(body);
    expect(response.status).toBe(space ? 507 : 413);
    expect(response.body).toMatchObject({
      code: space ? 'repository_space' : 'repository_source_limit',
      error: expect.stringContaining(space ? 'free space' : '512 MiB'),
    });
    expect(response.body.error).toContain(space ? '3 GiB' : 'smaller repository');
    effect.mockImplementationOnce(async () => {
      throw Error('private credential and path');
    });
    const unknown = await request(app).post(path).send(body);
    expect(unknown.status).toBe(409);
    expect(JSON.stringify(unknown.body)).not.toContain('private credential');
  },
);
it('requires an authenticated same-origin operator and resolves account binding on the server', async () => {
  const binding = { accountId: 'account', model: 'model', provider: 'openai' } as AccountBinding;
  const preview = vi.fn(async () => ({ id: 'prepared', repository: 'example/repo' }));
  const prepare = vi.fn(async () => ({ id: 'prepared', state: 'ready' }));
  let authenticated = false;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (authenticated) res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/repositories',
    createRepositoryWorkspaceRouter({
      resolveBinding: (id, model) => {
        if (id !== 'account' || model !== 'model') throw Error('unavailable');
        return binding;
      },
      catalog: () => ({ available: true, repositories: [] }),
      preview,
      prepare,
    }),
  );
  const body = {
    accountId: 'account',
    model: 'model',
    connectionId: 'connection',
    repository: 'example/repo',
  };
  expect((await request(app).post('/repositories/preview').send(body)).status).toBe(401);
  authenticated = true;
  expect(
    (
      await request(app)
        .post('/repositories/preview')
        .set('Origin', 'https://evil.invalid')
        .send(body)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/repositories/preview')
        .send({ ...body, binding })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .post('/repositories/preview')
        .send({ ...body, accountId: 'other' })
    ).status,
  ).toBe(409);
  expect(preview).not.toHaveBeenCalled();
  expect((await request(app).post('/repositories/preview').send(body)).status).toBe(200);
  expect(preview).toHaveBeenCalledWith(
    binding,
    'connection',
    'example/repo',
    expect.any(AbortSignal),
  );
  expect(
    (
      await request(app)
        .post('/repositories/8ca30b0d-3e65-4eeb-8244-f6277350818f/prepare')
        .send({ accountId: 'account', model: 'model', directory: '/arbitrary' })
    ).status,
  ).toBe(400);
  expect(prepare).not.toHaveBeenCalled();
  const ordinaryRuntime = {
    runOn: 'local',
    runtime: {
      account: { accountId: 'account', provider: 'openai', profileRevision: 'revision' },
      harness: 'responses',
      targetId: 'mac',
    },
  };
  expect(
    (
      await request(app)
        .post('/repositories/preview')
        .send({ ...body, ordinaryRuntime })
    ).status,
  ).toBe(200);
  expect(preview).toHaveBeenLastCalledWith(
    binding,
    'connection',
    'example/repo',
    expect.any(AbortSignal),
    ordinaryRuntime,
  );
  const requestId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
  expect(
    (
      await request(app)
        .post('/repositories/preview')
        .send({ ...body, requestId })
    ).status,
  ).toBe(200);
  expect(preview).toHaveBeenLastCalledWith(
    binding,
    'connection',
    'example/repo',
    expect.any(AbortSignal),
    undefined,
    requestId,
  );
  expect(
    (
      await request(app)
        .post('/repositories/preview')
        .send({ ...body, ordinaryRuntime, requestId })
    ).status,
  ).toBe(200);
  expect(preview).toHaveBeenLastCalledWith(
    binding,
    'connection',
    'example/repo',
    expect.any(AbortSignal),
    ordinaryRuntime,
    requestId,
  );
  for (const extra of [
    { requestId: '../bad' },
    { requestId, previewIntentFingerprint: 'a'.repeat(64) },
  ]) {
    expect(
      (
        await request(app)
          .post('/repositories/preview')
          .send({ ...body, ...extra })
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await request(app)
        .post('/repositories/preview')
        .send({ ...body, ordinaryRuntime: { ...ordinaryRuntime, modelEditable: true } })
    ).status,
  ).toBe(400);
});

it('loads a durable chat draft through operator authentication without accepting another account selection', async () => {
  const id = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
  const chatPreparation = vi.fn(() => ({
    repositoryChat: { id, accountId: 'bound-account', model: 'bound-model', prompt: 'Fix parser' },
  }));
  let authenticated = false;
  const app = express();
  app.use((_req, res, next) => {
    if (authenticated) res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/repositories',
    createRepositoryWorkspaceRouter({
      resolveBinding: vi.fn(),
      catalog: vi.fn(),
      preview: vi.fn(),
      prepare: vi.fn(),
      chatPreparation,
    }),
  );
  expect((await request(app).get(`/repositories/${id}/chat-preparation`)).status).toBe(401);
  authenticated = true;
  const response = await request(app).get(`/repositories/${id}/chat-preparation`);
  expect(response.status).toBe(200);
  expect(response.body.repositoryChat.accountId).toBe('bound-account');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(chatPreparation).toHaveBeenCalledWith(id);
  expect(
    (await request(app).get(`/repositories/${id}/chat-preparation?accountId=other`)).status,
  ).toBe(400);
  expect((await request(app).get('/repositories/not-an-id/chat-preparation')).status).toBe(400);
  chatPreparation.mockImplementationOnce(() => {
    throw Error('unavailable');
  });
  expect((await request(app).get(`/repositories/${id}/chat-preparation`)).status).toBe(404);
});
