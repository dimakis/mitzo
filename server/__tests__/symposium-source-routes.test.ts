import { exportLocalSource } from '../symposium-source-git.js';
import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware, login } from '../auth.js';
import { recentAppReauthorizationHandlers } from '../connections-router.js';
import { createSymposiumSourceRouter } from '../symposium-source-routes.js';
vi.mock('../symposium-source-git.js', () => ({
  inspectLocalSource: vi.fn(),
  exportLocalSource: vi.fn(async (_repos, plan) => ({
    manifest: { ...plan, bundleSha256: 'd'.repeat(64), bundleBytes: 1 },
    bundle: Buffer.from('x'),
  })),
}));
it('requires fresh auth, CSRF, exact scope and typed committed-history approval without caller paths', async () => {
  const apply = vi.fn(async (_input, authorize) => {
    authorize();
    return { commit: 'a'.repeat(40) };
  });
  const app = express();
  app.use(express.json(), authMiddleware);
  app.use(
    '/api/sessions/:id/symposium/source',
    createSymposiumSourceRouter({
      repositories: () => ({ selected: '/server/owned/path' }),
      getSession: () => ({
        sessionType: 'symposium',
        symposiumConfig: JSON.stringify({ revision: 4 }),
      }),
      getHost: () => ({
        status: () => ({ available: true, volumeGeneration: 'volume-gen' }),
        import: apply,
      }),
    } as never),
  );
  const token = (await login('test-passphrase-for-vitest'))!;
  const body = {
    plan: {
      repositoryId: 'selected',
      targetRepository: 'example/project',
      baseBranch: 'main',
      featureBranch: 'change',
      baseOid: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      sourceIdentity: 'c'.repeat(64),
      historyCommits: 1,
    },
    expectedRevision: 4,
    expectedGeneration: 'volume-gen',
    operationId: 'import-1',
    confirmation: 'IMPORT COMMITTED REPOSITORY HISTORY',
  };
  const post = (value: Record<string, unknown>, csrf = '') =>
    request(app)
      .post('/api/sessions/session/symposium/source/import')
      .set('Authorization', `Bearer ${token}`)
      .set('x-csrf-token', csrf)
      .send(value);
  expect((await post(body)).status).toBe(403);
  const auth = await request(app)
    .post('/api/sessions/session/symposium/source/reauthorize')
    .set('Authorization', `Bearer ${token}`)
    .send({ passphrase: 'test-passphrase-for-vitest' });
  expect(auth.status).toBe(200);
  expect((await post({ ...body, path: '/caller/path' }, auth.body.csrf)).status).toBe(400);
  expect((await post({ ...body, confirmation: 'yes' }, auth.body.csrf)).status).toBe(400);
  expect(apply).not.toHaveBeenCalled();
  expect((await post(body, auth.body.csrf)).status).toBe(200);
  expect(apply).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session',
      expectedRevision: 4,
      expectedGeneration: 'volume-gen',
      actor: expect.stringMatching(/^operator:/),
    }),
    expect.any(Function),
  );
  vi.mocked(exportLocalSource).mockRejectedValueOnce(
    new Error('ENOENT /private/account-state/auth.json'),
  );
  const failure = await post(body, auth.body.csrf);
  expect(failure.status).toBe(409);
  expect(JSON.stringify(failure.body)).not.toContain('/private/account-state');
  const status = await request(app)
    .get('/api/sessions/session/symposium/source')
    .set('Authorization', `Bearer ${token}`);
  expect(status.body.repositories).toEqual(['selected']);
  expect(JSON.stringify(status.body)).not.toContain('/server/owned/path');
  app.post('/other-app-auth', ...recentAppReauthorizationHandlers());
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(
      (
        await request(app)
          .post('/other-app-auth')
          .set('Authorization', `Bearer ${token}`)
          .send({ passphrase: 'test-passphrase-for-vitest' })
      ).status,
    ).toBe(200);
  }
  expect(
    (
      await request(app)
        .post('/api/sessions/session/symposium/source/reauthorize')
        .set('Authorization', `Bearer ${token}`)
        .send({ passphrase: 'test-passphrase-for-vitest' })
    ).status,
  ).toBe(429);
});

it('recovers only the retained imported source seal under recent operator authorization', async () => {
  const seal = vi.fn(async () => ({ state: 'complete', operationId: 'import-1' }));
  let state = {
    available: false,
    state: 'imported',
    admissionIssued: false,
    volumeGeneration: 'volume-gen',
    receipt: { operationId: 'import-1' },
    sourceSeal: null as null | { state: string; operationId: string },
  };
  const app = express();
  app.use(express.json(), authMiddleware);
  app.use(
    '/api/sessions/:id/symposium/source',
    createSymposiumSourceRouter({
      repositories: () => ({}),
      getSession: () => ({
        sessionType: 'symposium',
        symposiumConfig: JSON.stringify({ revision: 4 }),
      }),
      getHost: () => ({ status: () => state, seal }),
    } as never),
  );
  const token = (await login('test-passphrase-for-vitest'))!;
  const body = {
    expectedRevision: 4,
    expectedGeneration: 'volume-gen',
    operationId: 'import-1',
  };
  const post = (value: Record<string, unknown>, csrf = '') =>
    request(app)
      .post('/api/sessions/session/symposium/source/seal/recover')
      .set('Authorization', `Bearer ${token}`)
      .set('x-csrf-token', csrf)
      .send(value);
  expect((await post(body)).status).toBe(403);
  const auth = await request(app)
    .post('/api/sessions/session/symposium/source/reauthorize')
    .set('Authorization', `Bearer ${token}`)
    .send({ passphrase: 'test-passphrase-for-vitest' });
  expect(auth.status).toBe(200);
  expect((await post({ ...body, operationId: 'different' }, auth.body.csrf)).status).toBe(409);
  expect((await post({ ...body, arbitraryPath: '/host/private' }, auth.body.csrf)).status).toBe(
    400,
  );
  expect(seal).not.toHaveBeenCalled();
  expect((await post(body, auth.body.csrf)).status).toBe(200);
  expect(seal).toHaveBeenCalledWith('session', 'import-1', expect.any(AbortSignal));
  state = { ...state, sourceSeal: { state: 'complete', operationId: 'import-1' } };
  expect((await post(body, auth.body.csrf)).status).toBe(200);
  expect(seal).toHaveBeenCalledTimes(1);
  state = { ...state, admissionIssued: true };
  expect((await post(body, auth.body.csrf)).status).toBe(409);
});
