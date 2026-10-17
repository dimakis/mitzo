import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionCollaborationRouter } from '../session-collaboration-router.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';

afterEach(cleanupJoiningFixtures);
function application(f: Awaited<ReturnType<typeof createJoiningFixture>>) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('x-operator') === 'yes')
      res.locals.authSession = { id: 'authenticated-operator', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/collaborations',
    createSessionCollaborationRouter({ store: f.store, joining: f.owner() }),
  );
  return app;
}

it('recovers an authenticated HTTP join from the real retained ordinary preparation after restart', async () => {
  const f = await createJoiningFixture();
  let app = application(f);
  const path = `/collaborations/${f.group}`;
  expect((await request(app).post(`${path}/joins`).send(f.input)).status).toBe(401);
  expect(f.store.listSessions()).toHaveLength(1);
  const record = vi
    .spyOn(f.store.collaborationConversation, 'recordAllocation')
    .mockImplementationOnce(() => {
      throw new Error('private-provider-operation-not-public');
    });
  const interrupted = await request(app)
    .post(`${path}/joins`)
    .set('x-operator', 'yes')
    .send(f.input);
  expect(interrupted.status).toBe(503);
  expect(JSON.stringify(interrupted.body)).not.toContain('private-provider');
  record.mockRestore();
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  const retained = f.store.getOrdinarySessionPreparation(pending.allocationOperationId)!;
  expect(retained).toBeDefined();
  expect(f.authority.authorizeConfirmation).toHaveBeenCalledWith(
    expect.objectContaining({ operatorId: 'authenticated-operator' }),
    expect.any(AbortSignal),
  );
  expect(f.store.listSessions()).toHaveLength(2);
  f.reopen();
  f.resolvePreparation.mockClear();
  f.resolvePreparation.mockRejectedValue(new Error('must recover original allocation'));
  app = application(f);
  const read = await request(app).get(`${path}/joins/${pending.joinId}`).set('x-operator', 'yes');
  expect(read.status).toBe(200);
  expect(read.body.state).toBe('pending_preparation');
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  const recovered = await request(app)
    .post(`${path}/joins/${pending.joinId}/recover`)
    .set('x-operator', 'yes')
    .send({});
  expect(recovered.status).toBe(200);
  expect(recovered.headers['cache-control']).toContain('no-store');
  expect(recovered.body).toMatchObject({
    state: 'linked',
    sessionId: retained.sessionId,
    allocationOperationId: retained.allocationOperationId,
    execution: { enabled: false },
  });
  expect(f.authority.authorizeJoin).toHaveBeenLastCalledWith(
    expect.objectContaining({ operatorId: 'authenticated-operator' }),
    expect.any(AbortSignal),
  );
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  expect(f.store.listSessions()).toHaveLength(2);
  expect(f.store.getOrdinaryInitialCommandId(retained.sessionId)).toBeUndefined();
  expect(f.store.getSessionEvents(retained.sessionId)).toEqual([]);
  const retry = await request(app)
    .post(`${path}/joins/${pending.joinId}/recover`)
    .set('x-operator', 'yes')
    .send({});
  expect(retry.body).toEqual(recovered.body);
  expect(f.store.listSessions()).toHaveLength(2);
});

it('refuses actual unverified native capacity through HTTP without reserving a session', async () => {
  const f = await createJoiningFixture(false);
  const response = await request(application(f))
    .post(`/collaborations/${f.group}/joins`)
    .set('x-operator', 'yes')
    .send(f.input);
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('capacity_refused');
  expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  expect(f.store.listSessions()).toHaveLength(1);
});
