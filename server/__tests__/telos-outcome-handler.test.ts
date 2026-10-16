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
  const create = vi.fn(async (_input: TelosOutcomeCreation) => ({
    itemId: 'item',
    receipt: {
      ok: true as const,
      created: true,
      item: { id: 'item', summary: 'Studio' },
      delivery: { state: 'pending' },
    },
  }));
  const origin = vi.fn();
  const app = express();
  app.use(express.json());
  app.post(
    '/outcome',
    createTelosOutcomeHandler({
      verifyInternal: (req) => req.headers['x-internal-token'] === 'fixture',
      sessionId: () => sessionId,
      availableSource: (id) => id === 'planning',
    }),
  );
  return { app, create, origin };
}
it('does not let an internal tool token create an outcome without a retained reviewed source approval', async () => {
  const f = fixture();
  const res = await request(f.app)
    .post('/outcome')
    .set('X-Internal-Token', 'fixture')
    .set('X-Client-Id', 'client')
    .send(body);
  expect(res.status).toBe(403);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.origin).not.toHaveBeenCalled();
});
it('keeps the retired transport closed while preserving registered source attribution', async () => {
  const f = fixture();
  const response = await request(f.app)
    .post('/outcome')
    .set('X-Internal-Token', 'fixture')
    .send(body);
  expect(response.status).toBe(403);
  expect(response.body.error).toContain('Reviewed original source');
  expect(f.create).not.toHaveBeenCalled();
  expect(f.origin).not.toHaveBeenCalled();
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
it('authenticates before refusing the retired creation transport', async () => {
  const f = fixture();
  expect((await request(f.app).post('/outcome').send(body)).status).toBe(401);
  expect(f.create).not.toHaveBeenCalled();
  f.origin.mockImplementation(() => {
    throw Error('/private/database/source-bytes');
  });
  const res = await request(f.app).post('/outcome').set('X-Internal-Token', 'fixture').send(body);
  expect(res.status).toBe(403);
  expect(JSON.stringify(res.body)).not.toContain('/private');
});
