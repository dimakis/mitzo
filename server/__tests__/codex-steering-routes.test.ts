import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createCodexQueueRouter } from '../codex-queue-routes.js';
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ warn }) }));
const binding = {
  accountId: 'account',
  accountLabel: 'Account',
  provider: 'openai' as const,
  model: 'fixture',
  profileRevision: 'r1',
};
const input = {
  requestId: 'correction',
  targetCommandId: 'active',
  text: 'Current priorities are fine.',
};
function fixture(status: import('../codex-steering.js').CodexSteerResult['status'] = 'accepted') {
  const steer = vi.fn(async () => ({ status }));
  const authorizeMutation = vi.fn();
  const auth = { id: 'signed', expiresAt: Date.now() + 10000 };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = auth;
    next();
  });
  app.use(
    '/sessions',
    createCodexQueueRouter({
      authorizeMutation,
      binding: (id) => (id === 'chat' ? binding : undefined),
      overview: () => ({ queued: [], cancelledIds: [], hasMore: false }),
      cancel: () => 'not_found',
      retry: async () => 'not_found',
      reattach: async () => 'unavailable',
      steer,
    }),
  );
  return { app, steer, authorizeMutation, auth };
}
it('passes exact correction identity and middleware authorization to its original owner', async () => {
  const f = fixture();
  const res = await request(f.app).post('/sessions/chat/codex-queue/steer').send(input).expect(200);
  expect(res.body).toEqual({ requestId: 'correction', status: 'accepted' });
  expect(f.steer).toHaveBeenCalledExactlyOnceWith('chat', binding, input, f.auth);
});
it('passes validated screenshot bytes with the exact correction identity', async () => {
  const f = fixture();
  const body = { ...input, images: [{ data: 'aGk=', mediaType: 'image/png' }] };
  await request(f.app).post('/sessions/chat/codex-queue/steer').send(body).expect(200);
  expect(f.steer).toHaveBeenCalledExactlyOnceWith('chat', binding, body, f.auth);
});
it.each([
  { ...input, model: 'changed' },
  { ...input, authorization: { id: 'forged' } },
  { ...input, text: ' ' },
  { ...input, images: [{ data: 'bad!', mediaType: 'image/png' }] },
  { ...input, images: [{ data: 'aGk=', mediaType: 'image/svg+xml' }] },
  { ...input, images: [{ data: 'aGk=', mediaType: 'image/png', path: '/private/image' }] },
])('rejects correction overrides before calling the provider', async (body) => {
  const f = fixture();
  await request(f.app).post('/sessions/chat/codex-queue/steer').send(body).expect(400);
  expect(f.steer).not.toHaveBeenCalled();
});
it('fails closed on original-owner refusal', async () => {
  const f = fixture();
  f.authorizeMutation.mockImplementation(() => {
    throw Error('private');
  });
  await request(f.app).post('/sessions/chat/codex-queue/steer').send(input).expect(403);
  expect(f.steer).not.toHaveBeenCalled();
});

it('correlates an unexpected steering failure without exposing private payloads or claiming rejection', async () => {
  const f = fixture();
  f.steer.mockRejectedValueOnce(new TypeError('private-token-and-prompt'));
  const res = await request(f.app).post('/sessions/chat/codex-queue/steer').send(input).expect(409);
  expect(res.body).toMatchObject({
    code: 'turn_steering_unconfirmed',
    diagnosticId: expect.any(String),
  });
  expect(res.body.status).toBeUndefined();
  expect(res.body.error).toContain(res.body.diagnosticId);
  expect(warn).toHaveBeenLastCalledWith(
    'Turn correction could not be confirmed',
    expect.objectContaining({
      code: 'turn_steering_unconfirmed',
      stage: 'steering_dispatch',
      sessionId: 'chat',
      requestId: input.requestId,
      targetCommandId: input.targetCommandId,
      diagnosticId: res.body.diagnosticId,
      causeType: 'TypeError',
    }),
  );
  expect(JSON.stringify([res.body, warn.mock.calls])).not.toContain('private-token-and-prompt');
});
