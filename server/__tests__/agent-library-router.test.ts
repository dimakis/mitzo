import { afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentLibraryStore } from '../agent-library-store.js';
import { createAgentLibraryRouter } from '../agent-library-router.js';
import { selectCustodianOperation, custodianRoute } from '../symposium-custodian-protocol.js';

const definition = {
  name: 'Bob',
  descriptor: 'The architect',
  role: 'reviewer',
  instructions: 'Challenge assumptions.',
  expectedOutput: 'A decision brief',
  acceptanceCriteria: ['Use evidence'],
  modelPolicyRole: 'reviewer',
};
const stores: AgentLibraryStore[] = [];
function app(operator = true) {
  const store = new AgentLibraryStore(':memory:');
  stores.push(store);
  const app = express();
  app.use(express.json());
  if (operator)
    app.use((_req, res, next) => {
      res.locals.authSession = { id: 'verified-login' };
      next();
    });
  app.use('/api/agent-library', createAgentLibraryRouter(store));
  return app;
}
afterEach(() => stores.splice(0).forEach((store) => store.close()));
it('requires interactive operator authentication for reads and writes', async () => {
  const server = app(false);
  await request(server).get('/api/agent-library').expect(403);
  await request(server).post('/api/agent-library/drafts').send({}).expect(403);
});
it('saves a draft, publishes it, and exports its exact portable identity', async () => {
  const server = app();
  await request(server)
    .post('/api/agent-library/drafts')
    .send({
      profileId: 'bob',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'draft',
      definition,
    })
    .expect(200);
  const draftList = await request(server).get('/api/agent-library').expect(200);
  expect(draftList.body.versions).toEqual([]);
  await request(server)
    .post('/api/agent-library/publish')
    .send({ profileId: 'bob', expectedVersion: 1, idempotencyKey: 'publish' })
    .expect(200);
  const exported = await request(server).get('/api/agent-library/bob/1/export').expect(200);
  expect(exported.body.definition.descriptor).toBe('The architect');
  expect(exported.body).not.toHaveProperty('owner');
  const listed = await request(server).get('/api/agent-library').expect(200);
  expect(listed.body.drafts).toEqual([]);
  expect(listed.body.versions).toHaveLength(1);
});
it('returns a conflict for stale drafts and rejects caller-supplied ownership', async () => {
  const server = app();
  const body = {
    profileId: 'bob',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition,
  };
  await request(server).post('/api/agent-library/drafts').send(body).expect(200);
  await request(server)
    .post('/api/agent-library/drafts')
    .send({ ...body, idempotencyKey: 'stale' })
    .expect(409);
  await request(server)
    .post('/api/agent-library/drafts')
    .send({ ...body, owner: 'other' })
    .expect(400);
});
it('previews portable guidance and reports context as unresolved without model calls', async () => {
  const response = await request(app())
    .post('/api/agent-library/preview')
    .send({ definition })
    .expect(200);
  expect(response.body.profilePrompt).toContain('Bob · The architect');
  expect(response.body.profilePrompt).toContain('Challenge assumptions.');
  expect(response.body.contextResolved).toBe(false);
});
it('routes Library operations through the retained custodian rather than a second catalog owner', () => {
  for (const [method, path] of [
    ['GET', '/api/agent-library'],
    ['POST', '/api/agent-library/drafts'],
    ['POST', '/api/agent-library/publish'],
    ['POST', '/api/agent-library/preview'],
    ['POST', '/api/agent-library/import'],
    ['GET', '/api/agent-library/bob/1/export'],
  ]) {
    const selected = selectCustodianOperation(method, path);
    expect(selected).not.toBeNull();
    expect(custodianRoute(selected!)).toEqual({ method, path });
  }
});
