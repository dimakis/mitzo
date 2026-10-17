import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createSessionRemovalRouter } from '../session-removal.js';
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
