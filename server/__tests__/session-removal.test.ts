import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createSessionRemovalRouter, sessionNeedsSandboxReview } from '../session-removal.js';
import type { OpenShellLifecycleService } from '../openshell-lifecycle-service.js';

function fixture(managed = true) {
  const preview = vi.fn(async () => ({ token: 'review', action: 'stop_and_delete', blockers: [] }));
  const confirm = vi.fn(async () => 'deleted');
  const hide = vi.fn();
  const changed = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions',
    createSessionRemovalRouter({
      authorize: (_req, _res, next) => next(),
      lifecycle: () =>
        ({
          inventory: () => (managed ? [{ conversationId: 'c', state: 'retained' }] : []),
          preview,
          confirm,
        }) as unknown as OpenShellLifecycleService,
      hasSandbox: () => managed,
      hide,
      changed,
    }),
  );
  return { app, preview, confirm, hide, changed };
}
it('reviews sandbox release without changing the session', async () => {
  const f = fixture();
  const r = await request(f.app).get('/api/sessions/c/deletion-preview').expect(200);
  expect(r.body.sandbox.action).toBe('stop_and_delete');
  expect(f.preview).toHaveBeenCalledWith('c', expect.any(AbortSignal), 'delete');
  expect(f.hide).not.toHaveBeenCalled();
});
it('offers a legacy deletion review and consumes its token before hiding the chat', async () => {
  const previewLegacy = vi.fn(async () => ({
    token: 'legacy-review',
    action: 'stop_and_delete',
    blockers: [],
  }));
  const confirm = vi.fn(async () => 'deleted');
  const hide = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions',
    createSessionRemovalRouter({
      authorize: (_req, _res, next) => next(),
      lifecycle: () => ({ inventory: () => [], confirm }) as unknown as OpenShellLifecycleService,
      hasSandbox: () => true,
      previewLegacy: previewLegacy as never,
      hide,
      changed: vi.fn(),
    }),
  );
  const preview = await request(app).get('/api/sessions/c/deletion-preview').expect(200);
  expect(preview.body.sandbox?.token).toBe('legacy-review');
  expect(previewLegacy).toHaveBeenCalledWith('c', expect.any(AbortSignal));
  expect(hide).not.toHaveBeenCalled();
  await request(app).delete('/api/sessions/c').expect(409);
  await request(app).delete('/api/sessions/c').send({ cleanupToken: 'legacy-review' }).expect(200);
  expect(confirm).toHaveBeenCalledWith('legacy-review', expect.any(AbortSignal), 'c');
  expect(hide).toHaveBeenCalledWith('c');
});
it('does not apply removal authorization to unrelated session readers', async () => {
  const app = express();
  app.use(
    '/api/sessions',
    createSessionRemovalRouter({
      authorize: (_req, res) => {
        res.sendStatus(403);
      },
      lifecycle: () => null,
      hasSandbox: () => false,
      hide: vi.fn(),
      changed: vi.fn(),
    }),
  );
  app.get('/api/sessions/:id/meta', (_req, res) => {
    res.json({ readable: true });
  });
  await request(app).get('/api/sessions/c/meta').expect(200);
  await request(app).get('/api/sessions/c/deletion-preview').expect(403);
  await request(app).delete('/api/sessions/c').expect(403);
});
it('requires reviewed sandbox cleanup before hiding a managed chat', async () => {
  const f = fixture();
  await request(f.app).delete('/api/sessions/c').expect(409);
  expect(f.hide).not.toHaveBeenCalled();
  await request(f.app).delete('/api/sessions/c').send({ cleanupToken: 'review' }).expect(200);
  expect(f.confirm).toHaveBeenCalledWith('review', expect.any(AbortSignal), 'c');
  expect(f.hide).toHaveBeenCalledWith('c');
  expect(f.changed).toHaveBeenCalledWith('c');
});
it('preserves the chat when release fails or only stops the sandbox', async () => {
  const f = fixture();
  f.confirm.mockResolvedValueOnce('stopped');
  await request(f.app).delete('/api/sessions/c').send({ cleanupToken: 'review' }).expect(409);
  f.confirm.mockRejectedValueOnce(new Error('Checkpoint unavailable'));
  await request(f.app).delete('/api/sessions/c').send({ cleanupToken: 'review' }).expect(409);
  expect(f.hide).not.toHaveBeenCalled();
});
it('archives explicitly without granting consent or releasing the sandbox', async () => {
  const f = fixture();
  await request(f.app).delete('/api/sessions/c?archive=1').expect(200);
  expect(f.hide).toHaveBeenCalledWith('c');
  expect(f.confirm).not.toHaveBeenCalled();
});
it('removes a chat with no sandbox without requiring a lifecycle token', async () => {
  const f = fixture(false);
  expect(
    (await request(f.app).get('/api/sessions/c/deletion-preview').expect(200)).body.sandbox,
  ).toBeNull();
  await request(f.app).delete('/api/sessions/c').expect(200);
  expect(f.hide).toHaveBeenCalledWith('c');
});

it('blocks legacy remote ownership with a custom workdir and preserves explicit local routing', async () => {
  const meta = { cwd: '/custom/mgmt', accountBinding: { provider: 'openai' as const } };
  expect(sessionNeedsSandboxReview(meta, {})).toBe(true);
  expect(sessionNeedsSandboxReview(meta, { runtimeLocation: 'openshell' })).toBe(true);
  expect(sessionNeedsSandboxReview(meta, { runtimeLocation: 'local' })).toBe(false);
  expect(
    sessionNeedsSandboxReview({ cwd: '/custom/mgmt' }, { legacyOpenShellConfigured: true }),
  ).toBe(true);
  expect(
    sessionNeedsSandboxReview(
      { cwd: '/local/mgmt', accountBinding: { provider: 'anthropic-vertex' } },
      {},
    ),
  ).toBe(false);
  const hide = vi.fn();
  const app = express();
  app.use(
    '/api/sessions',
    createSessionRemovalRouter({
      authorize: (_req, _res, next) => next(),
      lifecycle: () => null,
      hasSandbox: () => sessionNeedsSandboxReview(meta, {}),
      hide,
      changed: vi.fn(),
    }),
  );
  expect(
    (await request(app).get('/api/sessions/legacy/deletion-preview').expect(200)).body
      .blockedReason,
  ).toMatch(/ownership/);
  await request(app).delete('/api/sessions/legacy').expect(409);
  expect(hide).not.toHaveBeenCalled();
  await request(app).delete('/api/sessions/legacy?archive=1').expect(200);
  expect(hide).toHaveBeenCalledWith('legacy');
});
