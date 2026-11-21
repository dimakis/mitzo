import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../../packages/protocol/src/event-store.js';
import { createPrMonitorController } from '../pr-monitor-controller.js';
import { createInteractiveAuth } from '../interactive-auth-core.js';
import type { PrMonitorSubscription } from '@mitzo/protocol';
import express from 'express';
import request from 'supertest';
import { emptyExternalCi } from './fixtures/pr-monitor-external-ci.js';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { SessionCapabilityGrants } from '../session-capability-grants.js';
import { createSessionCapabilityRouter } from '../session-capability-router.js';
import { recentAppReauthorizationHandlers } from '../connections-router.js';
import { SessionPromptStore } from '../session-prompt-store.js';
import { SessionPromptService } from '../session-prompt-service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const connectionId = '9c6bb0d4-081f-4f55-86f8-60c703452053';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const stores: EventStore[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
async function fixture(path = ':memory:') {
  let store = new EventStore(path);
  stores.push(store);
  store.upsertSession({ sessionId: 'chat' });
  const newAuth = () =>
    createInteractiveAuth({
      passphrase: 'offline-passphrase',
      secret: 'offline-secret-longer-than-thirty-two-characters',
      maxAgeHours: 1,
      cookieName: 'offline',
    });
  let auth = newAuth();
  auth.setRevocationStore(store);
  const login = (await auth.authenticateToken((await auth.login('offline-passphrase'))!))!;
  const execution: PrMonitorSubscription['execution'] = {
    binding: {
      version: 2,
      account: { accountId: 'a', provider: 'openai-codex', profileRevision: '1' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: '1' },
    },
    workspaceId: 'workspace',
    selectionRevision: 'selection',
    profileRevision: 'profile',
  };
  let connection = {
    id: connectionId,
    ownerId: 'operator',
    templateId: 'github-readonly',
    status: 'active',
    revision: 1,
    identity: 'owner',
    verifiedAt: 1,
    archivedAt: null,
    desiredAccountIds: ['a'],
    publicConfig: { allowedRepositories: ['owner/repo'] },
  };
  let currentHead = head;
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const read = vi.fn(async (endpoint: string, _signal: AbortSignal, current: () => void) => {
    current();
    return {
      status: 200,
      headers: {
        'x-ratelimit-resource': 'core',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(resetAt),
      },
      data:
        emptyExternalCi(endpoint) ??
        (endpoint === '/user'
          ? { id: 42, login: 'owner' }
          : endpoint.includes('/reviews') || endpoint.includes('/comments')
            ? []
            : endpoint.includes('/actions')
              ? { total_count: 0, workflow_runs: [] }
              : {
                  node_id: 'pr-node',
                  number: 7,
                  title: 'PR',
                  state: 'open',
                  merged: false,
                  head: { sha: currentHead },
                  base: {
                    sha: base,
                    repo: { node_id: 'repo-node', name: 'repo', owner: { login: 'owner' } },
                  },
                }),
    };
  });
  let executionAvailable = true;
  const makeController = () =>
    createPrMonitorController({
      eventStore: store,
      execution: () => {
        if (!executionAvailable) throw Error('conversation_unavailable');
        return execution;
      },
      connection: () => connection,
      auth: {
        hasPersistentRevocationAuthority: auth.hasPersistentRevocationAuthority,
        isInteractive: auth.isAuthenticatedOperatorSessionId,
        isLoginCurrent: (a) => a.expiresAt > Date.now() && !auth.isSessionRevoked(a),
      },
      read,
      eligibleAuthors: ['owner'],
    });
  let controller = makeController();
  const input = {
    requestId: 'register',
    connectionId,
    connectionRevision: 1,
    owner: 'owner',
    name: 'repo',
    pr: 7,
    expectedExecutionDigest: controller.context(login, 'chat').executionDigest,
  };
  return {
    get store() {
      return store;
    },
    get controller() {
      return controller;
    },
    get auth() {
      return auth;
    },
    login,
    execution,
    read,
    input,
    missedPush: () => {
      currentHead = 'c'.repeat(40);
    },
    restart: async () => {
      await controller.close();
      store.close();
      stores.splice(stores.indexOf(store), 1);
      store = new EventStore(path);
      stores.push(store);
      auth = newAuth();
      auth.setRevocationStore(store);
      controller = makeController();
    },
    loseExecution: () => {
      executionAvailable = false;
    },
    loseConnection: () => {
      connection = { ...connection, revision: 2 };
    },
  };
}
it('reconciles a missed push after a cold SQLite/auth restart and honors retained logout without a browser or model turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-monitor-runtime-'));
  directories.push(dir);
  const f = await fixture(join(dir, 'events.db'));
  const registered = await f.controller.register(f.login, 'chat', f.input);
  const id = registered.projection.subscription.id;
  f.controller.consent.issue(f.login, {
    requestId: 'watch',
    conversationId: 'chat',
    subscriptionId: id,
    expectedRevision: 1,
    expectedAuthorityRevision: 0,
    durationMinutes: 30,
    reviewedScope: registered.reviewedScope,
  });
  await f.controller.reconcileDue();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  f.missedPush();
  await f.restart();
  expect(f.auth.isAuthenticatedOperatorSessionId(f.login.id)).toBe(false);
  now += 120000;
  f.read.mockClear();
  await f.controller.reconcileDue();
  const recovered = f.store.prMonitor.read('ordinary:user', 'chat', id);
  expect(recovered.refreshState).toBe('current');
  expect(recovered.subscription.head).toMatchObject({ sha: 'c'.repeat(40), generation: 2 });
  expect(recovered.counters).toMatchObject({ observations: 2, modelTurns: 0 });
  expect(f.read).toHaveBeenCalledTimes(12);
  f.store.revokeAuthSession(f.login);
  await f.restart();
  now += 120000;
  f.read.mockClear();
  await f.controller.reconcileDue();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.store.prMonitor.read('ordinary:user', 'chat', id)).toMatchObject({
    refreshState: 'blocked',
    diagnostic: { code: 'authority_unavailable' },
    outbox: null,
  });
  await f.controller.close();
});
it('registers a canonical paused PR only after interactive scope review and starts no observation until Watch consent', async () => {
  const f = await fixture();
  await f.controller.reconcileDue();
  expect(f.read).not.toHaveBeenCalled();
  await expect(
    f.controller.register({ ...f.login, id: 'agent' }, 'chat', f.input),
  ).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  const registered = await f.controller.register(f.login, 'chat', f.input);
  expect(registered.projection.subscription).toMatchObject({
    lifecycle: 'paused',
    github: { repositoryId: 'repo-node', prNodeId: 'pr-node', principalId: 'github:42' },
  });
  expect(registered.projection.subscription.watch).toBeNull();
  f.read.mockClear();
  expect(await f.controller.register(f.login, 'chat', f.input)).toEqual(registered);
  await f.controller.reconcileDue();
  expect(f.read).not.toHaveBeenCalled();
  const id = registered.projection.subscription.id;
  f.controller.consent.issue(f.login, {
    requestId: 'watch',
    conversationId: 'chat',
    subscriptionId: id,
    expectedRevision: 1,
    expectedAuthorityRevision: 0,
    durationMinutes: 30,
    reviewedScope: registered.reviewedScope,
  });
  await f.controller.reconcileDue();
  const view = f.controller.list(f.login, 'chat')[0];
  expect(view.refreshState).toBe('current');
  expect(view.counters.modelTurns).toBe(0);
  await f.controller.close();
});
it('fences mutable connection/execution state and durable logout before background reads', async () => {
  const f = await fixture();
  const registered = await f.controller.register(f.login, 'chat', f.input);
  const id = registered.projection.subscription.id;
  f.controller.consent.issue(f.login, {
    requestId: 'watch',
    conversationId: 'chat',
    subscriptionId: id,
    expectedRevision: 1,
    expectedAuthorityRevision: 0,
    durationMinutes: 30,
    reviewedScope: registered.reviewedScope,
  });
  f.loseConnection();
  f.read.mockClear();
  await f.controller.reconcileDue();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.store.prMonitor.read('ordinary:user', 'chat', id).diagnostic?.code).toBe(
    'connection_unavailable',
  );
  f.store.revokeAuthSession(f.login);
  expect(() => f.controller.list(f.login, 'chat')).toThrow('authority_unavailable');
  await f.controller.close();
});
it('rejects caller execution replacement and host identity mismatch without creating a subscription', async () => {
  const f = await fixture();
  await expect(
    f.controller.register(f.login, 'chat', { ...f.input, expectedExecutionDigest: '0'.repeat(64) }),
  ).rejects.toThrow('execution_changed');
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockResolvedValue({ status: 200, headers: {}, data: { id: 43, login: 'other' } } as never);
  await expect(f.controller.register(f.login, 'chat', f.input)).rejects.toThrow(
    'connection_unavailable',
  );
  expect(f.store.prMonitor.list('ordinary:user', 'chat')).toEqual([]);
  await f.controller.close();
});
it('freezes the reviewed execution while registration reads are in flight', async () => {
  const f = await fixture();
  f.read.mockImplementationOnce(async () => {
    f.execution.selectionRevision = 'changed-during-read';
    return { status: 200, headers: {}, data: { id: 42, login: 'owner' } } as never;
  });
  await expect(f.controller.register(f.login, 'chat', f.input)).rejects.toThrow(
    'execution_changed',
  );
  expect(f.store.prMonitor.list('ordinary:user', 'chat')).toEqual([]);
  await f.controller.close();
});
it('drains cancelled registration even when transport ignores abort', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  f.read.mockImplementation(() => new Promise(() => undefined));
  let error = '';
  const pending = f.controller.register(f.login, 'chat', f.input).catch((e) => {
    error = e.message;
  });
  await vi.advanceTimersByTimeAsync(20001);
  // AbortSignal.timeout uses the native clock; close must also actively abort.
  const closing = f.controller.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toBe('read_aborted');
  await pending;
  await closing;
  expect(f.store.prMonitor.list('ordinary:user', 'chat')).toEqual([]);
});
it('connects the real Access registration/consent routes to the existing scheduler without model delivery', async () => {
  const f = await fixture();
  const { registry, session } = capabilityFixture();
  session.sessionId = 'chat';
  session.ownedLocalAuthSessionId = f.login.id;
  const grants = new SessionCapabilityGrants(registry, undefined, f.controller.consent);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = f.login;
    next();
  });
  app.post('/reauth', ...recentAppReauthorizationHandlers());
  app.use(
    '/api/sessions/:id/access-grants',
    createSessionCapabilityRouter({
      grants,
      monitor: f.controller,
      hasSession: (id) => id === 'chat',
    }),
  );
  const path = '/api/sessions/chat/access-grants';
  expect((await request(app).get(`${path}/pr-monitor`)).status).toBe(200);
  expect(
    (
      await request(app)
        .post(`${path}/pr-monitor`)
        .set('Host', '127.0.0.1')
        .set('Origin', 'http://127.0.0.1')
        .set('X-Mitzo-Access-Intent', 'manage-grants')
        .send(f.input)
    ).status,
  ).toBe(403);
  expect(f.read).not.toHaveBeenCalled();
  const reauth = await request(app)
    .post('/reauth')
    .set('Host', '127.0.0.1')
    .set('Origin', 'http://127.0.0.1')
    .send({ passphrase: 'test-passphrase-for-vitest' });
  expect(reauth.status).toBe(200);
  const created = await request(app)
    .post(`${path}/pr-monitor`)
    .set('Host', '127.0.0.1')
    .set('Origin', 'http://127.0.0.1')
    .set('X-Mitzo-Access-Intent', 'manage-grants')
    .send({ ...f.input, csrf: reauth.body.csrf });
  expect(created.status).toBe(201);
  const s = created.body.projection.subscription;
  const watch = await request(app)
    .post(`${path}/pr-watch/${s.id}`)
    .set('Host', '127.0.0.1')
    .set('Origin', 'http://127.0.0.1')
    .set('X-Mitzo-Access-Intent', 'manage-grants')
    .send({
      requestId: 'watch-http',
      expectedRevision: s.revision,
      expectedAuthorityRevision: 0,
      durationMinutes: 30,
      reviewedScope: created.body.reviewedScope,
      csrf: reauth.body.csrf,
    });
  expect(watch.status).toBe(201);
  const prompts = new SessionPromptStore(':memory:');
  const deliver = vi.fn();
  const service = new SessionPromptService(
    prompts,
    {
      authorized: () => true,
      inspect: async () => ({ busy: false }),
      deliver,
      receipt: () => 'absent',
      close: () => undefined,
    },
    f.controller,
  );
  try {
    await service.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(prompts.deliveries()).toEqual([]);
    const projection = await request(app).get(`${path}/pr-monitor`);
    expect(projection.body.subscriptions[0].refreshState).toBe('current');
    expect(projection.body.subscriptions[0].counters.modelTurns).toBe(0);
    f.loseExecution();
    vi.spyOn(grants, 'list').mockImplementation(() => {
      throw Error('live context unavailable');
    });
    const retained = await request(app).get(`${path}/pr-monitor`);
    expect(retained.status).toBe(200);
    expect(retained.body.executionDigest).toBeNull();
    expect(retained.body.executionAvailable).toBe(false);
    expect(retained.body.subscriptions[0].subscription.id).toBe(s.id);
    const revoked = await request(app)
      .post(`${path}/pr-watch/${s.id}/revoke`)
      .set('Host', '127.0.0.1')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Mitzo-Access-Intent', 'manage-grants')
      .send({ requestId: 'revoke-offline', expectedRevision: 2, expectedAuthorityRevision: 1 });
    expect(revoked.status).toBe(200);
    expect(f.store.prMonitor.read('ordinary:user', 'chat', s.id).subscription.lifecycle).toBe(
      'paused',
    );
    await service.cancelSession('chat');
    expect(f.store.prMonitor.read('ordinary:user', 'chat', s.id).subscription.lifecycle).toBe(
      'removed',
    );
  } finally {
    await service.drain();
    prompts.close();
  }
});
