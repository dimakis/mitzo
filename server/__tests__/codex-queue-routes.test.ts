import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createCodexQueueRouter } from '../codex-queue-routes.js';
const binding = {
  accountId: 'a',
  accountLabel: 'a',
  provider: 'openai-codex',
  model: 'm',
  profileRevision: 'r',
};
function setup(result: 'cancelled' | 'not_queued' | 'not_found' = 'cancelled') {
  const cancel = vi.fn(() => result);
  const app = express();
  app.use(
    '/api/sessions',
    createCodexQueueRouter({
      binding: (id) => (id === 'known' ? binding : undefined),
      commands: () => [
        { id: 'waiting', prompt: 'duplicate', model: 'm', status: 'queued' },
        { id: 'done', prompt: 'executed', model: 'm', status: 'completed' },
        { id: 'cancelled', prompt: 'old', model: 'm', status: 'cancelled' },
      ],
      cancel,
    }),
  );
  return { app, cancel };
}
it('lists only waiting summaries and cancelled tombstone IDs', async () => {
  const { app } = setup();
  const res = await request(app).get('/api/sessions/known/codex-queue').expect(200);
  expect(res.body).toEqual({
    queued: [{ id: 'waiting', preview: 'duplicate' }],
    cancelledIds: ['cancelled'],
  });
});
it.each([
  ['cancelled', 200],
  ['not_queued', 409],
  ['not_found', 404],
] as const)('returns %s cancellation outcome', async (result, status) => {
  const { app, cancel } = setup(result);
  await request(app).post('/api/sessions/known/codex-queue/waiting/cancel').expect(status);
  expect(cancel).toHaveBeenCalledWith('known', binding, 'waiting');
});
it('does not cancel an unknown conversation', async () => {
  const { app, cancel } = setup();
  await request(app).post('/api/sessions/other/codex-queue/waiting/cancel').expect(404);
  expect(cancel).not.toHaveBeenCalled();
});
it('does not expose binding or storage errors to the client', async () => {
  const { app, cancel } = setup();
  cancel.mockImplementation(() => {
    throw new Error('private binding detail');
  });
  const res = await request(app).post('/api/sessions/known/codex-queue/waiting/cancel').expect(409);
  expect(JSON.stringify(res.body)).not.toContain('private binding detail');
});
