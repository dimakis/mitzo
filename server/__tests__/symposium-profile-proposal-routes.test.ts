import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import { createSymposiumProfileProposalRouter } from '../symposium-profile-proposal-routes.js';

let directory: string;
let store: SymposiumProfileProposalStore;
let app: express.Express;
const definition = {
  name: 'Reviewer',
  role: 'reviewer' as const,
  instructions: 'Review the change',
  expectedOutput: 'Findings',
  acceptanceCriteria: ['Cite evidence'],
  modelPolicyRole: 'reviewer',
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-profile-proposal-route-'));
  store = new SymposiumProfileProposalStore(join(directory, 'events.db'));
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers.authorization === 'Bearer interactive') res.locals.authSession = { id: 'jti' };
    next();
  });
  app.use(
    '/proposals',
    createSymposiumProfileProposalRouter(store, (id) => id === 'chat'),
  );
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('only interactive auth can list or save proposals for an existing conversation', async () => {
  const draft = store.propose('user', 'chat', 'call-1', { definition });
  expect((await request(app).get('/proposals').query({ sessionId: 'chat' })).status).toBe(403);
  expect(
    (
      await request(app)
        .get('/proposals')
        .set('Authorization', 'Bearer interactive')
        .query({ sessionId: 'missing' })
    ).status,
  ).toBe(404);
  const listed = await request(app)
    .get('/proposals')
    .set('Authorization', 'Bearer interactive')
    .query({ sessionId: 'chat' });
  expect(listed.body[0].proposalId).toBe(draft.proposalId);
  const save = await request(app)
    .post(`/proposals/${draft.proposalId}/save`)
    .set('Authorization', 'Bearer interactive')
    .send({ sessionId: 'chat', profileId: 'reviewer', expectedRevision: 0, definition });
  expect(save.status).toBe(200);
  expect(save.body).toMatchObject({ profileId: 'reviewer', revision: 1 });
  expect(
    (
      await request(app)
        .get('/proposals')
        .set('Authorization', 'Bearer interactive')
        .query({ sessionId: 'chat' })
    ).body,
  ).toEqual([]);
});

it('accepts bounded draft creation for remote ordinary chats and refuses unknown sessions or identity fields', async () => {
  const body = { sessionId: 'chat', idempotencyKey: 'tool-call', definition };
  expect((await request(app).post('/proposals').send(body)).status).toBe(403);
  const post = (input: object) =>
    request(app).post('/proposals').set('Authorization', 'Bearer interactive').send(input);
  expect((await post({ ...body, sessionId: 'missing' })).status).toBe(404);
  expect((await post({ ...body, owner: 'forged' })).status).toBe(400);
  const created = await post(body);
  expect(created.status).toBe(200);
  expect(created.body.state).toBe('pending');
  expect((await post(body)).body.proposalId).toBe(created.body.proposalId);
  expect((await post({ ...body, definition: { ...definition, name: 'Changed' } })).status).toBe(
    409,
  );
});
