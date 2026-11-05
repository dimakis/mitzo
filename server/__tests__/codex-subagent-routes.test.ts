import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createCodexSubagentRouter } from '../codex-subagent-routes.js';

function fixture() {
  const owner = {
    list: vi.fn(() => []),
    control: vi.fn(async (_input, authorize) => {
      authorize();
      return 'accepted';
    }),
    subscribe: vi.fn(() => () => {}),
  };
  const authorize = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    '/sessions',
    createCodexSubagentRouter({
      authorize,
      owner: (id) => (id === 'chat' ? owner : undefined),
      retained: () => [],
    }),
  );
  return { app, owner, authorize };
}
it('requires the original operator for child reads as well as mutations', async () => {
  const f = fixture();
  f.authorize.mockImplementation(() => {
    throw Error('Private owner details');
  });
  await request(f.app).get('/sessions/chat/codex-subagents').expect(403);
  await request(f.app)
    .post('/sessions/chat/codex-subagents/control')
    .send({ requestId: 'r', threadId: 'child', action: 'stop' })
    .expect(403);
  expect(f.owner.list).not.toHaveBeenCalled();
  expect(f.owner.control).not.toHaveBeenCalled();
});
it('passes a validated exact child request and rechecks authority at delivery', async () => {
  const f = fixture();
  const input = { requestId: 'r', threadId: 'child', action: 'message', text: 'Check whitespace' };
  const response = await request(f.app)
    .post('/sessions/chat/codex-subagents/control')
    .send(input)
    .expect(200);
  expect(response.body).toEqual({ requestId: 'r', status: 'accepted' });
  expect(f.owner.control.mock.calls[0][0]).toEqual(input);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each([
  { requestId: 'r', threadId: 'child', action: 'message', text: ' ' },
  { requestId: 'r', threadId: 'child', action: 'stop', model: 'changed' },
  { requestId: 'r', threadId: 'child', action: 'stop', authorization: {} },
])('refuses control-plane overrides before the native owner runs', async (input) => {
  const f = fixture();
  await request(f.app).post('/sessions/chat/codex-subagents/control').send(input).expect(400);
  expect(f.owner.control).not.toHaveBeenCalled();
});
it('retains cold output without making a missing runtime executable', async () => {
  const f = fixture();
  const response = await request(f.app).get('/sessions/cold/codex-subagents').expect(200);
  expect(response.body).toEqual({ agents: [], available: false });
  const control = await request(f.app)
    .post('/sessions/cold/codex-subagents/control')
    .send({ requestId: 'r', threadId: 'child', action: 'stop' })
    .expect(200);
  expect(control.body.status).toBe('rejected');
});
