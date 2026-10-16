import type { TelosOutcomeCreation } from '@mitzo/protocol';
import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTelosOutcomeHandler } from '../telos-outcome-handler.js';
const body = {
  summary: 'Studio',
  intent: 'Record',
  rationale: 'Music',
  acceptanceCriteria: ['Ready'],
  profile: 'personal',
  milestones: ['Plan'],
};
function fixture(sessionId: string | undefined = 'planning') {
  const create = vi.fn(async (_input: TelosOutcomeCreation) => ({ itemId: 'item' }));
  const origin = vi.fn();
  const app = express();
  app.use(express.json());
  app.post(
    '/outcome',
    createTelosOutcomeHandler({
      verifyInternal: (req) => req.headers['x-internal-token'] === 'fixture',
      sessionId: () => sessionId,
      availableSource: (id) => id === 'planning',
      createOutcome: create,
      recordOrigin: origin,
    }),
  );
  return { app, create, origin };
}
it('derives origin and canonical recovery identity from the actual registered session', async () => {
  const f = fixture();
  const res = await request(f.app)
    .post('/outcome')
    .set('X-Internal-Token', 'fixture')
    .set('X-Client-Id', 'transport-not-a-session')
    .send(body);
  expect(res.status).toBe(200);
  expect(res.body.item.id).toBe('item');
  expect(f.create).toHaveBeenCalledWith(
    expect.objectContaining({
      contextHints: expect.objectContaining({ sessionIds: ['planning'] }),
      idempotencyKey: expect.stringMatching(/^planning:/),
    }),
  );
  expect(f.origin).toHaveBeenCalledWith(
    { itemId: 'item', idempotencyKey: f.create.mock.calls[0][0].idempotencyKey },
    { kind: 'conversation', id: 'planning' },
  );
});
it('never substitutes a client ID or unknown-session for missing or unavailable session authority', async () => {
  for (const id of [undefined, 'hidden']) {
    const f = fixture(id);
    // Explicit undefined bypasses the fixture default for the missing binding.
    const app = id === undefined ? express() : f.app;
    if (id === undefined) {
      app.use(express.json());
      app.post(
        '/outcome',
        createTelosOutcomeHandler({
          verifyInternal: () => true,
          sessionId: () => undefined,
          availableSource: () => true,
          createOutcome: f.create,
          recordOrigin: f.origin,
        }),
      );
    }
    const res = await request(app)
      .post('/outcome')
      .set('X-Internal-Token', 'fixture')
      .set('X-Client-Id', 'client')
      .send(body);
    expect(res.status).toBe(409);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.origin).not.toHaveBeenCalled();
  }
});
it('authenticates before creating and returns a safe error for uncertain linking', async () => {
  const f = fixture();
  expect((await request(f.app).post('/outcome').send(body)).status).toBe(401);
  expect(f.create).not.toHaveBeenCalled();
  f.origin.mockImplementation(() => {
    throw Error('/private/database/source-bytes');
  });
  const res = await request(f.app).post('/outcome').set('X-Internal-Token', 'fixture').send(body);
  expect(res.status).toBe(503);
  expect(JSON.stringify(res.body)).not.toContain('/private');
});
