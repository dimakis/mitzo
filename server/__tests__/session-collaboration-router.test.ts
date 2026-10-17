import express from 'express';
import type { CollaborationJoin, CollaborationJoinInput } from '@mitzo/protocol';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { revokeAuthSession } from '../auth.js';
import { EventStore } from '../event-store.js';
import { createSessionCollaborationRouter } from '../session-collaboration-router.js';
let store: EventStore, app: express.Express, path: string;
beforeEach(() => {
  store = new EventStore(':memory:');
  path = `/api/session-collaborations/${randomUUID()}`;
  for (const sessionId of ['first', 'local', 'sandbox'])
    store.upsertSession({ sessionId, conversationSource: 'mitzo' });
  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header('x-operator') === 'yes')
      res.locals.authSession = {
        id: 'operator',
        expiresAt: req.header('x-expired') ? Date.now() - 1 : Date.now() + 60000,
      };
    next();
  });
  app.use('/api/session-collaborations', createSessionCollaborationRouter({ store }));
});
afterEach(() => store.close());
const body = { expectedRevision: 0, participantSessionIds: ['first', 'local'] };
it('requires interactive operator authorization on reads and mutations', async () => {
  expect((await request(app).get(path)).status).toBe(401);
  expect((await request(app).get('/api/session-collaborations?sessionId=local')).status).toBe(401);
  const unauthenticated = await request(app).put(path).send(body);
  expect(
    unauthenticated.status,
    JSON.stringify({
      method: 'PUT',
      path,
      body: unauthenticated.body,
      text: unauthenticated.text,
      headers: unauthenticated.headers,
    }),
  ).toBe(401);
  expect(
    (await request(app).get(path).set('x-operator', 'yes').set('x-expired', 'yes')).status,
  ).toBe(401);
});
it('links, reopens and unlinks real existing sessions without executing or creating a chat', async () => {
  const response = await request(app).put(path).set('x-operator', 'yes').send(body);
  expect(response.status).toBe(200);
  expect((await request(app).get(path).set('x-operator', 'yes')).body).toEqual({
    ...response.body,
    unavailableParticipantSessionIds: [],
  });
  expect(response.headers['cache-control']).toContain('no-store');
  const discovery = await request(app)
    .get('/api/session-collaborations?sessionId=local')
    .set('x-operator', 'yes');
  expect(discovery.body.collaborations).toEqual([response.body]);
  expect(discovery.body.nextCursor).toBeNull();
  expect(
    (
      await request(app)
        .get('/api/session-collaborations?sessionId=missing')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(404);
  expect(
    (
      await request(app)
        .get('/api/session-collaborations?sessionId=local&after=invalid')
        .set('x-operator', 'yes')
    ).status,
  ).toBe(400);
  store.hideSession('first');
  expect(
    (await request(app).get(path).set('x-operator', 'yes')).body.unavailableParticipantSessionIds,
  ).toEqual(['first']);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ expectedRevision: 1, participantSessionIds: ['local'] })
    ).status,
  ).toBe(200);
  expect(store.listSessions()).toHaveLength(2);
  expect(store.getSession('first')).toMatchObject({ sessionId: 'first', isHidden: true });
  expect(store.getSessionEvents('local')).toEqual([]);
});
it('recovers accepted updates and edits other members while preserving an unavailable reference', async () => {
  const accepted = await request(app).put(path).set('x-operator', 'yes').send(body);
  expect(accepted.status).toBe(200);
  store.hideSession('first');
  const retry = await request(app).put(path).set('x-operator', 'yes').send(body);
  expect(retry.status).toBe(200);
  expect(retry.body).toEqual(accepted.body);
  const updated = await request(app)
    .put(path)
    .set('x-operator', 'yes')
    .send({ expectedRevision: 1, participantSessionIds: ['first', 'sandbox'] });
  expect(updated.status).toBe(200);
  expect(updated.body).toMatchObject({ revision: 2, participantSessionIds: ['first', 'sandbox'] });
  expect((await request(app).get(path).set('x-operator', 'yes')).body).toEqual({
    ...updated.body,
    unavailableParticipantSessionIds: ['first'],
  });
  expect((await request(app).put(path).set('x-operator', 'yes').send(body)).status).toBe(409);
  expect(store.getSessionEvents('sandbox')).toEqual([]);
});

it('rejects cross-origin writes, stale revisions, unknown participants and execution fields', async () => {
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .set('Origin', 'https://other.invalid')
        .send(body)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ ...body, model: 'replacement' })
    ).status,
  ).toBe(400);
  expect((await request(app).put(path).set('x-operator', 'yes').send(body)).status).toBe(200);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ ...body, participantSessionIds: ['first', 'sandbox'] })
    ).status,
  ).toBe(409);
  expect(
    (await request(app).get(`/api/session-collaborations/${randomUUID()}`).set('x-operator', 'yes'))
      .status,
  ).toBe(404);
  expect(
    (
      await request(app)
        .put(path)
        .set('x-operator', 'yes')
        .send({ expectedRevision: 1, participantSessionIds: ['local', 'missing'] })
    ).status,
  ).toBe(404);
});

const joiningInput = (): CollaborationJoinInput => ({
  requestId: randomUUID(),
  expectedMembershipRevision: 1,
  name: 'Reviewer',
  settings: {
    binding: {
      version: 2,
      account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
    },
    selection: {
      version: 1,
      agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: 'offline-fixture',
      thinking: null,
    },
    repositoryWorkspaceId: 'workspace',
  },
  snapshot: { snapshotId: randomUUID(), sha256: 'a'.repeat(64) },
});
function installJoining() {
  const operatorId = `trusted-${randomUUID()}`;
  const input = joiningInput();
  const result: CollaborationJoin = {
    version: 1,
    joinId: randomUUID(),
    name: input.name,
    membershipRevision: 1,
    settings: input.settings,
    snapshot: input.snapshot,
    allocationOperationId: randomUUID(),
    state: 'pending_preparation',
    sessionId: null,
    linkedFromRevision: null,
    execution: {
      enabled: false,
      reason:
        'Fresh-agent preparation and ordinary delivery are not wired. No session or model is started.',
    },
  };
  const joining = { confirm: vi.fn(async () => result), recover: vi.fn(async () => result) };
  const mounted = express();
  mounted.use(express.json());
  mounted.use((req, res, next) => {
    if (req.header('x-operator') === 'yes')
      res.locals.authSession = { id: operatorId, expiresAt: Date.now() + 60000 };
    next();
  });
  mounted.use('/api/session-collaborations', createSessionCollaborationRouter({ store, joining }));
  store.setSessionCollaboration(path.split('/').at(-1)!, body);
  return { mounted, joining, input, result, operatorId };
}
it('delegates confirmation and recovery with authenticated identity and a bounded signal', async () => {
  const { mounted, joining, input, result, operatorId } = installJoining();
  const response = await request(mounted)
    .post(`${path}/joins`)
    .set('x-operator', 'yes')
    .send(input);
  expect(response.status).toBe(200);
  expect(response.body).toEqual(result);
  expect(response.headers['cache-control']).toContain('no-store');
  expect(joining.confirm).toHaveBeenCalledWith(
    operatorId,
    path.split('/').at(-1),
    input,
    expect.any(AbortSignal),
  );
  const recovered = await request(mounted)
    .post(`${path}/joins/${result.joinId}/recover`)
    .set('x-operator', 'yes')
    .send({});
  expect(recovered.status).toBe(200);
  expect(joining.recover).toHaveBeenCalledWith(
    operatorId,
    path.split('/').at(-1),
    result.joinId,
    expect.any(AbortSignal),
  );
  expect(
    (await request(mounted).get(`${path}/joins/${result.joinId}`).set('x-operator', 'yes')).status,
  ).toBe(404);
  expect(joining.confirm).toHaveBeenCalledTimes(1);
  expect(joining.recover).toHaveBeenCalledTimes(1);
});
it('rejects unauthenticated, cross-origin, malformed, spoofed and missing-group joins before owner calls', async () => {
  const { mounted, joining, input, result } = installJoining();
  expect((await request(mounted).post(`${path}/joins`).send(input)).status).toBe(401);
  expect(
    (
      await request(mounted)
        .post(`${path}/joins`)
        .set('x-operator', 'yes')
        .set('Origin', 'https://other.invalid')
        .send(input)
    ).status,
  ).toBe(403);
  for (const payload of [{}, { ...input, operatorId: 'spoofed' }])
    expect(
      (await request(mounted).post(`${path}/joins`).set('x-operator', 'yes').send(payload)).status,
    ).toBe(400);
  expect(
    (
      await request(mounted)
        .post(`/api/session-collaborations/${randomUUID()}/joins`)
        .set('x-operator', 'yes')
        .send(input)
    ).status,
  ).toBe(404);
  expect(
    (
      await request(mounted)
        .post(`${path}/joins/${result.joinId}/recover`)
        .set('x-operator', 'yes')
        .send({ operatorId: 'spoofed' })
    ).status,
  ).toBe(400);
  expect(
    (await request(mounted).post(`${path}/joins/invalid/recover`).set('x-operator', 'yes').send({}))
      .status,
  ).toBe(400);
  expect(joining.confirm).not.toHaveBeenCalled();
  expect(joining.recover).not.toHaveBeenCalled();
});
it('keeps absent joining unavailable including recovery and keeps messages and snapshots unavailable', async () => {
  const { input, result } = installJoining();
  for (const suffix of ['joins', `joins/${result.joinId}/recover`, 'messages', 'snapshots']) {
    const response = await request(app)
      .post(`${path}/${suffix}`)
      .set('x-operator', 'yes')
      .send(suffix === 'joins' ? input : {});
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('execution_unavailable');
  }
});
it('reports absent joining before parsing its body while validating collaboration identity', async () => {
  installJoining();
  for (const suffix of ['joins', `joins/${randomUUID()}/recover`]) {
    const response = await request(app)
      .post(`${path}/${suffix}`)
      .set('x-operator', 'yes')
      .send({ unexpected: 'unsupported' });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('execution_unavailable');
  }
  expect(
    (
      await request(app)
        .post(`/api/session-collaborations/${randomUUID()}/joins`)
        .set('x-operator', 'yes')
        .send({})
    ).status,
  ).toBe(404);
  expect(
    (
      await request(app)
        .post('/api/session-collaborations/invalid/joins')
        .set('x-operator', 'yes')
        .send({})
    ).status,
  ).toBe(400);
});
it('conceals provider errors and rejects private or malformed owner results', async () => {
  const { mounted, joining, input, result } = installJoining();
  joining.confirm.mockRejectedValueOnce(new Error('private-provider-thread-secret'));
  const failed = await request(mounted).post(`${path}/joins`).set('x-operator', 'yes').send(input);
  expect(failed.status).toBe(503);
  expect(JSON.stringify(failed.body)).not.toContain('private-provider');
  joining.confirm.mockResolvedValueOnce({ ...result, providerThreadId: 'secret' } as typeof result);
  const invalid = await request(mounted).post(`${path}/joins`).set('x-operator', 'yes').send(input);
  expect(invalid.status).toBe(503);
  expect(JSON.stringify(invalid.body)).not.toContain('secret');
});

it('aborts in-flight joining on operator revocation and refuses a late result', async () => {
  const { mounted, joining, input, result, operatorId } = installJoining();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal!: AbortSignal;
  joining.confirm.mockImplementationOnce(async (...args: unknown[]) => {
    signal = args[3] as AbortSignal;
    started();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    return result;
  });
  const response = request(mounted)
    .post(`${path}/joins`)
    .set('x-operator', 'yes')
    .send(input)
    .then((value) => value);
  await Promise.race([
    entered,
    response.then(() => {
      throw new Error('Joining owner was not entered');
    }),
  ]);
  revokeAuthSession({ id: operatorId, expiresAt: Date.now() + 60000 });
  expect(signal.aborted).toBe(true);
  expect((await response).status).toBe(403);
});
