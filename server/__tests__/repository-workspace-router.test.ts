import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createRepositoryWorkspaceRouter } from '../repository-workspace-router.js';
import type { AccountBinding } from '@mitzo/protocol';
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
});
