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
    if (req.headers.authorization === 'Bearer interactive')
      res.locals.authSession = { id: 'jti', expiresAt: Date.now() + 60000 };
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

it('lists reviewable task proposals and accepts only exact explicit task saves', async () => {
  const { SymposiumProfileStore } = await import('../symposium-profiles.js');
  const profiles = new SymposiumProfileStore(join(directory, 'events.db'));
  const profile = profiles.save('user', {
    profileId: 'reviewer',
    expectedRevision: 0,
    idempotencyKey: 'profile',
    definition,
  });
  profiles.close();
  const task = {
    taskId: 'daily',
    expectedRevision: 0,
    definition: {
      name: 'Daily',
      objective: '',
      profile: {
        profileId: profile.profileId,
        revision: profile.revision,
        contentHash: profile.contentHash,
      },
      execution: null,
      workspace: null,
      schedule: null,
      notificationPolicy: 'results',
      outputPolicy: 'session',
    },
  };
  const post = (path: string, body: object) =>
    request(app).post(path).set('Authorization', 'Bearer interactive').send(body);
  const draft = await post('/proposals', {
    kind: 'task',
    sessionId: 'chat',
    idempotencyKey: 'task-call',
    ...task,
  });
  expect(draft.status).toBe(200);
  expect(draft.body).toMatchObject({ kind: 'task', state: 'pending', ...task });
  const list = () =>
    request(app)
      .get('/proposals')
      .set('Authorization', 'Bearer interactive')
      .query({ sessionId: 'chat' });
  expect((await list()).body[0].proposalId).toBe(draft.body.proposalId);
  const save = await post(`/proposals/${draft.body.proposalId}/save`, {
    sessionId: 'chat',
    kind: 'task',
    ...task,
  });
  expect(save.status).toBe(200);
  expect(save.body).toMatchObject({
    taskId: 'daily',
    revision: 1,
    configuration: { state: 'draft' },
  });
  expect((await list()).body[0].savedTask).toEqual(save.body);
  expect(
    (
      await post(`/proposals/${draft.body.proposalId}/save`, {
        sessionId: 'chat',
        kind: 'task',
        ...task,
        expectedRevision: 1,
      })
    ).status,
  ).toBe(409);
});

it.each(['cancel', 'revoke', 'expire'])(
  'rejects %s at canonical proposal dispatch before writes',
  async (change) => {
    const { bindCustodianAuthority } = await import('../symposium-custodian-authority.js');
    const auth = { id: `canonical-task-${change}`, expiresAt: Date.now() + 60000 };
    const controller = new AbortController();
    let revoked = false;
    const guarded = express();
    guarded.use(express.json());
    guarded.use((req, res, next) => {
      res.locals.authSession = auth;
      bindCustodianAuthority(req, {
        authorization: auth,
        assertCurrent() {
          if (revoked) throw Error('Revoked');
        },
        publicationSignal: controller.signal,
      });
      next();
    });
    guarded.use(
      '/proposals',
      createSymposiumProfileProposalRouter(store, () => {
        if (change === 'cancel') controller.abort();
        if (change === 'revoke') revoked = true;
        if (change === 'expire') auth.expiresAt = 0;
        return true;
      }),
    );
    const response = await request(guarded)
      .post('/proposals')
      .send({
        kind: 'task',
        sessionId: 'chat',
        idempotencyKey: 'guarded-call',
        taskId: 'guarded',
        expectedRevision: 0,
        definition: {
          name: 'Guarded',
          objective: '',
          profile: { profileId: 'missing', revision: 1, contentHash: 'a'.repeat(64) },
          execution: null,
          workspace: null,
          schedule: null,
          notificationPolicy: 'results',
          outputPolicy: 'session',
        },
      });
    expect(response.status).toBe(403);
    expect(store.listTaskProposals('user', 'chat')).toEqual([]);
  },
);
