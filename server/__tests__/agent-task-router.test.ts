import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { AgentTaskStore } from '../agent-task-store.js';
import { AgentTaskService } from '../agent-task-service.js';
import { createAgentTaskRouter } from '../agent-task-router.js';
import { authMiddleware, operatorAuthMiddleware, revokeAuthSession, login } from '../auth.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
import { custodianRoute, selectCustodianOperation } from '../symposium-custodian-protocol.js';
import { createCustodianProxy } from '../symposium-custodian-proxy.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-task-api-'));
  const path = join(root, 'events.db');
  const profiles = new SymposiumProfileStore(path);
  const tasks = new AgentTaskStore(path);
  // Seed the existing published-profile store on the task owner's connection.
  const profile = profiles.save('user', {
    profileId: 'legacy',
    expectedRevision: 0,
    idempotencyKey: 'publish',
    definition: {
      name: 'Legacy',
      role: 'reviewer',
      instructions: 'Review',
      expectedOutput: 'Findings',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'reviewer',
    },
  });
  cleanup.push(() => {
    tasks.close();
    profiles.close();
    rmSync(root, { recursive: true, force: true });
  });
  const service = new AgentTaskService(tasks);
  const app = express();
  app.use(express.json(), authMiddleware, operatorAuthMiddleware);
  app.use('/api/agent-tasks', createAgentTaskRouter(service));
  const input = {
    taskId: 'task-1',
    expectedRevision: 0,
    idempotencyKey: 'create',
    definition: {
      name: 'Draft',
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
  return { app, input, tasks };
}
let counter = 0;
function command(method: string, path: string, body = {}) {
  const selected = selectCustodianOperation(method, path);
  expect(selected).not.toBeNull();
  return {
    ...selected!,
    epoch: 1,
    requestId: `request-${++counter}`,
    body,
    query: {},
    authorization: { id: `login-${counter}`, expiresAt: Date.now() + 60000 },
  };
}
it('authenticates CRUD through closed owner dispatch, retaining tasks across rotating login JTIs without inference', async () => {
  const f = fixture();
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Inference forbidden'));
  const send = (method: string, path: string, body = {}) =>
    dispatchCustodianHttp(f.app, command(method, path, body), () => {});
  expect((await request(f.app).get('/api/agent-tasks')).status).toBe(401);
  expect((await send('POST', '/api/agent-tasks', f.input)).status).toBe(200);
  expect((await send('GET', '/api/agent-tasks')).body).toHaveLength(1);
  expect((await send('GET', '/api/agent-tasks/task-1')).body).toMatchObject({ revision: 1 });
  const edit = {
    expectedRevision: 1,
    idempotencyKey: 'edit',
    definition: { ...f.input.definition, name: 'Edited' },
  };
  expect((await send('PUT', '/api/agent-tasks/task-1', edit)).status).toBe(200);
  expect(
    (await send('PUT', '/api/agent-tasks/task-1', { ...edit, idempotencyKey: 'stale' })).status,
  ).toBe(409);
  expect((await send('POST', '/api/agent-tasks', { ...f.input, owner: 'attacker' })).status).toBe(
    400,
  );
  expect(
    (
      await send('DELETE', '/api/agent-tasks/task-1', {
        expectedRevision: 2,
        idempotencyKey: 'delete',
      })
    ).status,
  ).toBe(200);
  expect((await send('GET', '/api/agent-tasks/task-1')).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects POST edits without changing the task or consuming the retry key', async () => {
  const f = fixture();
  const send = (method: string, path: string, body: object) =>
    dispatchCustodianHttp(f.app, command(method, path, body), () => {});
  const first = await send('POST', '/api/agent-tasks', f.input);
  expect(first.status).toBe(200);
  const edit = {
    expectedRevision: 1,
    idempotencyKey: 'edit-key',
    definition: { ...f.input.definition, name: 'Edited' },
  };
  expect((await send('POST', '/api/agent-tasks', { ...edit, taskId: 'task-1' })).status).toBe(400);
  expect(f.tasks.get('user', 'task-1')).toEqual(first.body);
  expect((await send('PUT', '/api/agent-tasks/task-1', edit)).status).toBe(200);
  expect((await send('POST', '/api/agent-tasks', f.input)).body).toEqual(first.body);
  expect(f.tasks.get('user', 'task-1')?.revision).toBe(2);
});
it('rejects PUT creation without persisting a task or consuming the retry key', async () => {
  const f = fixture();
  const { taskId, ...body } = f.input;
  const result = await dispatchCustodianHttp(
    f.app,
    command('PUT', `/api/agent-tasks/${taskId}`, body),
    () => {},
  );
  expect(result.status).toBe(400);
  expect(f.tasks.get('user', taskId)).toBeNull();
  expect(
    (await dispatchCustodianHttp(f.app, command('POST', '/api/agent-tasks', f.input), () => {}))
      .status,
  ).toBe(200);
});
it('rejects expired, revoked and dispatch-invalidated authority before persisting', async () => {
  const f = fixture();
  const input = command('POST', '/api/agent-tasks', f.input);
  input.authorization.expiresAt = Date.now() - 1;
  expect((await dispatchCustodianHttp(f.app, input, () => {})).status).toBe(403);
  input.authorization.expiresAt = Date.now() + 60000;
  revokeAuthSession(input.authorization);
  expect((await dispatchCustodianHttp(f.app, input, () => {})).status).toBe(403);
  await expect(
    dispatchCustodianHttp(f.app, command('POST', '/api/agent-tasks', f.input), () => {
      throw Error('revoked epoch');
    }),
  ).rejects.toThrow(/epoch/);
  expect(f.tasks.list('user')).toEqual([]);
});
it('fences unsupported task namespace aliases and never falls through to a controller-local owner', async () => {
  const client = { request: vi.fn(), invalidate: vi.fn() };
  const app = express();
  app.use(createCustodianProxy(client));
  app.use((_req, res) => res.status(599).json({ error: 'local fallback' }));
  for (const path of [
    '/api/agent-tasks/task-1/run',
    '/api/AGENT-TASKS/task-1',
    '/api/agent-tasks/bad%2Fid',
    '/api/agent-tasks/task-1/schedule',
  ])
    await request(app).post(path).expect(400);
  expect(client.request).not.toHaveBeenCalled();
});
it('round trips only enumerated task operations through owner IPC', () => {
  for (const [method, path] of [
    ['GET', '/api/agent-tasks'],
    ['GET', '/api/agent-tasks/task-1'],
    ['POST', '/api/agent-tasks'],
    ['PUT', '/api/agent-tasks/task-1'],
    ['DELETE', '/api/agent-tasks/task-1'],
  ])
    expect(custodianRoute(command(method, path))).toEqual({ method, path });
  expect(selectCustodianOperation('POST', '/api/agent-tasks/task-1/run')).toBeNull();
});
it('forwards authenticated task writes to the original owner and enforces JSON/origin and revocation', async () => {
  const f = fixture();
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const invoke = vi.fn(async (input) =>
    dispatchCustodianHttp(f.app, { ...input, epoch: 1 }, () => {}),
  );
  const client = { request: invoke, invalidate: vi.fn() };
  const controller = express();
  controller.use(express.json(), createCustodianProxy(client));
  const send = () =>
    request(controller).post('/api/agent-tasks').set('Authorization', `Bearer ${token}`);
  await send().set('Origin', 'https://untrusted.test').send(f.input).expect(403);
  await send().type('text').send('{}').expect(415);
  expect(invoke).not.toHaveBeenCalled();
  await send().send(f.input).expect(200);
  expect(f.tasks.list('user')).toHaveLength(1);
  expect(JSON.stringify(invoke.mock.calls)).not.toContain(token);
  invoke.mockImplementationOnce(async (input) => {
    revokeAuthSession(input.authorization);
    return { status: 200, body: [] };
  });
  await request(controller)
    .get('/api/agent-tasks')
    .set('Authorization', `Bearer ${token}`)
    .expect(403);
  expect(client.invalidate).toHaveBeenCalledOnce();
});
