import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ContextSnapshotResponseSchema,
  type ContextSnapshotOwner,
  type ContextSnapshotRequest,
} from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { SessionRegistry } from '../session-registry.js';
import {
  inspectClaudeContext,
  type ContextInspectionOwner,
} from '../context-measurement-control.js';
import { type ContextSnapshotAuthority } from '../context-snapshot-lifecycle.js';
import { createRuntimeContextSnapshots } from '../context-snapshot-runtime.js';
import { createContextSnapshotRouter } from '../context-snapshot-router.js';
import { revokeAuthSession } from '../auth.js';
import { normalizeCodexContext } from '../context-measurement-adapters.js';
import { createCodexContextSnapshotAdapter } from '../codex-context-snapshot.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.useRealTimers();
});
const raw = () => ({
  model: 'fixture-model',
  totalTokens: 60,
  maxTokens: 90,
  rawMaxTokens: 100,
  percentage: 60,
  gridRows: [],
  categories: [{ id: 'messages', name: 'Messages', kind: 'used', tokens: 60, color: 'red' }],
  memoryFiles: [],
  mcpTools: [],
  agents: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(path = ':memory:') {
  const events = new EventStore(path);
  cleanup.push(() => events.close());
  events.upsertSession({ sessionId: 'chat', cwd: '/offline' });
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  registry.register('client', {
    sessionId: 'chat',
    transport: { isOpen: () => true, send: () => {} },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const session = registry.get('client')!;
  const query = { getContextUsage: vi.fn(async () => raw()) };
  const native: ContextInspectionOwner = {
    identity: {
      sessionId: 'chat',
      threadId: 'thread',
      queryId: 'query',
      turnId: 'turn',
      scope: 'parent',
      ownerGeneration: 'generation-1',
    },
    binding: {
      engine: 'claude',
      placement: 'local',
      model: 'fixture-model',
      accountRef: 'account',
      runtimeBindingRevision: 'binding-1',
    },
    observedAt: Date.now(),
    active: true,
    query,
  };
  const owner: ContextSnapshotOwner = {
    scope: { identity: { ...native.identity }, binding: { ...native.binding } },
    state: 'active',
    collect: async (input) => {
      input.assertCurrent();
      return inspectClaudeContext({
        current: () => (native.active ? native : undefined),
        signal: input.signal,
        detail: input.detail,
        authorizeFull: input.authorizeFull,
      });
    },
  };
  session.contextSnapshotOwner = owner;
  const lifecycle = createRuntimeContextSnapshots(events, registry);
  const authority: ContextSnapshotAuthority = {
    key: 'operator',
    current: () => true,
    allowTokenCount: async () => true,
  };
  const refresh = (
    overrides: Partial<ContextSnapshotRequest> = {},
    signal = new AbortController().signal,
    auth = authority,
  ) =>
    lifecycle.refresh(
      'chat',
      { requestId: randomUUID(), detail: 'summary', ...overrides },
      auth,
      signal,
    );
  return { events, registry, session, native, query, owner, lifecycle, authority, refresh };
}

it('passes the real control adapter through registry ownership, durable validation and passive cached reads', async () => {
  const f = fixture();
  expect(f.lifecycle.read('chat')).toMatchObject({ status: 'unavailable', reason: 'not_observed' });
  const first = await f.refresh();
  expect(ContextSnapshotResponseSchema.parse(first)).toMatchObject({
    status: 'available',
    revision: 1,
    snapshot: { usedTokens: 60, binding: { accountRef: 'account' }, identity: { turnId: 'turn' } },
  });
  expect(await f.refresh()).toEqual(first);
  expect(f.lifecycle.read('chat')).toEqual(first);
  expect(f.query.getContextUsage).toHaveBeenCalledTimes(1);
  first.snapshot!.categories.length = 0;
  expect(f.lifecycle.read('chat').snapshot!.categories).toHaveLength(1);
});

it('coalesces same-authority summary collection but one cancelled waiter does not cancel its sibling', async () => {
  const f = fixture(),
    control = deferred<ReturnType<typeof raw>>();
  f.query.getContextUsage.mockImplementation(() => control.promise);
  const controller = new AbortController();
  const first = f.refresh({}, controller.signal),
    second = f.refresh();
  await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(await first).toMatchObject({ status: 'cancelled' });
  control.resolve(raw());
  expect(await second).toMatchObject({ status: 'available' });
});

it('cancels the collection when all waiters leave and rejects the late result', async () => {
  const f = fixture(),
    control = deferred<ReturnType<typeof raw>>(),
    controller = new AbortController();
  f.query.getContextUsage.mockImplementation(() => control.promise);
  const work = f.refresh({}, controller.signal);
  await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(await work).toMatchObject({ status: 'cancelled' });
  control.resolve(raw());
  await new Promise<void>((r) => setImmediate(r));
  expect(f.events.contextSnapshots.read('chat').snapshot).toBeUndefined();
});

it.each(['compacted', 'suspended', 'query_retired'] as const)(
  'fences an in-flight first observation on %s',
  async (reason) => {
    const f = fixture(),
      control = deferred<ReturnType<typeof raw>>();
    f.query.getContextUsage.mockImplementation(() => control.promise);
    const work = f.refresh();
    await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
    f.lifecycle.invalidate('chat', reason);
    expect(await work).toMatchObject({ reason });
    control.resolve(raw());
    await new Promise<void>((r) => setImmediate(r));
    expect(f.events.contextSnapshots.read('chat')).toMatchObject({ revision: 1, reason });
    expect(f.events.contextSnapshots.read('chat').snapshot).toBeUndefined();
  },
);

it.each(['accountRef', 'model', 'runtimeBindingRevision'] as const)(
  'rejects late delivery after %s replacement',
  async (field) => {
    const f = fixture(),
      control = deferred<ReturnType<typeof raw>>();
    f.query.getContextUsage.mockImplementation(() => control.promise);
    const work = f.refresh();
    await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
    f.owner.scope.binding[field] = 'replacement';
    control.resolve(raw());
    expect(await work).toMatchObject({ reason: 'scope_changed' });
    expect(f.events.contextSnapshots.read('chat').revision).toBe(0);
  },
);

it('rejects a successor owner with identical labels and prevents cross-session or subagent writes', async () => {
  const f = fixture(),
    control = deferred<ReturnType<typeof raw>>();
  f.query.getContextUsage.mockImplementation(() => control.promise);
  const work = f.refresh();
  await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
  f.session.contextSnapshotOwner = { ...f.owner };
  control.resolve(raw());
  expect(await work).toMatchObject({ reason: 'scope_changed' });
  f.session.contextSnapshotOwner = f.owner;
  f.query.getContextUsage.mockImplementation(async () => raw());
  const result = await f.refresh();
  const snapshot = result.snapshot!;
  expect(() =>
    f.events.contextSnapshots.save('other', snapshot, f.owner.scope, 0, () => {}),
  ).toThrow();
  expect(
    f.lifecycle.observe(f.owner, {
      ...snapshot,
      identity: { ...snapshot.identity, scope: 'subagent', parentSessionId: 'parent' },
    }),
  ).toBe(false);
  expect(f.events.contextSnapshots.read('chat').revision).toBe(1);
});

it('preserves the last valid snapshot after malformed control data and exposes stale capacity', async () => {
  const f = fixture();
  await f.refresh();
  f.lifecycle.invalidate('chat', 'compacted');
  f.query.getContextUsage.mockResolvedValue({ ...raw(), totalTokens: -5 });
  expect(await f.refresh()).toMatchObject({
    status: 'failed',
    reason: 'invalid_response',
    snapshot: { usedTokens: 60, freshness: { state: 'stale' }, capacity: { stale: true } },
  });
  expect(f.events.contextSnapshots.read('chat').snapshot!.usedTokens).toBe(60);
});

it('rejects duplicate/out-of-order observations without clobbering valid evidence', async () => {
  const f = fixture();
  const snapshot = (await f.refresh()).snapshot!;
  expect(f.lifecycle.observe(f.owner, snapshot)).toBe(false);
  expect(f.lifecycle.observe(f.owner, { ...snapshot, observedAt: snapshot.observedAt - 1 })).toBe(
    false,
  );
  expect(f.events.contextSnapshots.read('chat').revision).toBe(1);
  expect(f.lifecycle.observe(f.owner, { ...snapshot, observedAt: Date.now() + 50000 })).toBe(false);
});

it('captures a new terminal summary before retirement even when a summary was recently cached', async () => {
  const f = fixture();
  const first = await f.refresh();
  f.query.getContextUsage.mockImplementation(async () => ({
    ...raw(),
    totalTokens: 70,
    categories: [],
  }));
  // Make the native host receipt strictly newer; equal timestamps are conservatively duplicate.
  vi.useFakeTimers();
  vi.setSystemTime(first.snapshot!.observedAt + 10);
  const captured = await f.lifecycle.captureBeforeRetirement(
    'chat',
    f.authority,
    new AbortController().signal,
  );
  f.native.active = false;
  expect(captured).toMatchObject({
    status: 'stale',
    reason: 'turn_completed',
    snapshot: { usedTokens: 70 },
  });
  expect(f.query.getContextUsage).toHaveBeenCalledTimes(2);
});

it('does not refresh detached/suspended owners; reattach requires a new collection after invalidation', async () => {
  const f = fixture();
  await f.refresh();
  f.registry.detach('client');
  expect(await f.refresh()).toMatchObject({ reason: 'adapter_not_attached' });
  f.registry.reattach('client', { isOpen: () => true, send: () => {} });
  expect(f.lifecycle.read('chat')).toMatchObject({ status: 'stale' });
  f.registry.suspend('client', 0);
  expect(await f.refresh()).toMatchObject({ reason: 'adapter_not_attached' });
  f.registry.resume('client');
  expect(f.query.getContextUsage).toHaveBeenCalledTimes(1);
});

it('keeps ordinary Claude/OpenShell unsupported and event-only owners explicit', async () => {
  const f = fixture();
  f.owner.scope.binding.placement = 'openshell';
  expect(await f.refresh()).toMatchObject({ reason: 'unsupported_route' });
  f.owner.scope.binding.engine = 'codex';
  f.owner.collect = undefined;
  expect(await f.refresh()).toMatchObject({ reason: 'refresh_unsupported' });
  expect(f.query.getContextUsage).not.toHaveBeenCalled();
});

it('bounds a hung collection and rejects its late reply', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    control = deferred<ReturnType<typeof raw>>();
  f.query.getContextUsage.mockImplementation(() => control.promise);
  const work = f.refresh();
  await vi.advanceTimersByTimeAsync(5001);
  expect(await work).toMatchObject({ reason: 'timed_out' });
  control.resolve(raw());
  await Promise.resolve();
  expect(f.events.contextSnapshots.read('chat').revision).toBe(0);
});

it('rechecks authority after async full consent and before delivery without silently dispatching', async () => {
  const f = fixture(),
    consent = deferred<boolean>();
  f.authority.allowTokenCount = () => consent.promise;
  const work = f.refresh({ detail: 'full', allowTokenCount: true });
  f.authority.current = () => false;
  consent.resolve(true);
  expect(await work).toMatchObject({ reason: 'authority_expired' });
  expect(f.query.getContextUsage).not.toHaveBeenCalled();
});

it('requires explicit full consent and never redispatches a durable uncertain request after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-context-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'events.sqlite'),
    f = fixture(path);
  expect(await f.refresh({ detail: 'full' })).toMatchObject({
    reason: 'token_count_not_authorized',
  });
  const id = randomUUID(),
    consent = deferred<boolean>();
  f.authority.allowTokenCount = () => consent.promise;
  const work = f.refresh({ detail: 'full', requestId: id, allowTokenCount: true });
  const reopened = fixture(path);
  expect(
    await reopened.refresh({ detail: 'full', requestId: id, allowTokenCount: true }),
  ).toMatchObject({ reason: 'superseded' });
  expect(reopened.query.getContextUsage).not.toHaveBeenCalled();
  consent.resolve(false);
  expect(await work).toMatchObject({ reason: 'token_count_not_authorized' });
});

it('cold restart/history reads preserve identity and measurements as stale without dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-context-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'events.sqlite'),
    f = fixture(path);
  await f.refresh();
  const restored = fixture(path);
  expect(restored.lifecycle.read('chat')).toMatchObject({
    status: 'stale',
    reason: 'restored',
    snapshot: {
      usedTokens: 60,
      identity: { ownerGeneration: 'generation-1' },
      capacity: { stale: true },
    },
  });
  expect(restored.query.getContextUsage).not.toHaveBeenCalled();
  restored.owner.scope.binding.accountRef = 'different-account';
  expect(restored.lifecycle.read('chat').snapshot).toBeUndefined();
});

function http(f: ReturnType<typeof fixture>, authenticated = true) {
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (authenticated) res.locals.authSession = auth;
    next();
  });
  app.use('/sessions/:id/context-snapshot', createContextSnapshotRouter(f.events, f.lifecycle));
  return { app, auth };
}
it('routes authenticated passive reads and explicit bounded refresh without accepting client owner overrides', async () => {
  const f = fixture(),
    { app } = http(f);
  expect((await request(http(f, false).app).get('/sessions/chat/context-snapshot')).status).toBe(
    401,
  );
  expect((await request(app).get('/sessions/missing/context-snapshot')).status).toBe(404);
  expect((await request(app).get('/sessions/chat/context-snapshot')).body.status).toBe(
    'unavailable',
  );
  expect(f.query.getContextUsage).not.toHaveBeenCalled();
  expect(
    (
      await request(app)
        .post('/sessions/chat/context-snapshot/refresh')
        .send({ requestId: randomUUID() })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/sessions/chat/context-snapshot/refresh')
        .set('X-Mitzo-Context-Intent', 'refresh-summary')
        .send({ requestId: randomUUID(), accountRef: 'other' })
    ).status,
  ).toBe(400);
  const result = await request(app)
    .post('/sessions/chat/context-snapshot/refresh')
    .set('X-Mitzo-Context-Intent', 'refresh-summary')
    .send({ requestId: randomUUID() });
  expect(result.status).toBe(200);
  expect(result.body.status).toBe('available');
  expect(result.headers['cache-control']).toBe('no-store');
});

it('revocation during a routed refresh prevents both storage and response delivery', async () => {
  const f = fixture(),
    { app, auth } = http(f),
    control = deferred<ReturnType<typeof raw>>();
  f.query.getContextUsage.mockImplementation(() => control.promise);
  const work = request(app)
    .post('/sessions/chat/context-snapshot/refresh')
    .set('X-Mitzo-Context-Intent', 'refresh-summary')
    .send({ requestId: randomUUID() })
    .then((response) => response);
  await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
  revokeAuthSession(auth);
  control.resolve(raw());
  const response = await work;
  expect(response.status).toBe(401);
  expect(response.body.snapshot).toBeUndefined();
  expect(f.events.contextSnapshots.read('chat').revision).toBe(0);
});

it('invalidates pending and cached evidence across detach/reattach without an intervening read', async () => {
  const f = fixture(),
    control = deferred<ReturnType<typeof raw>>();
  f.query.getContextUsage.mockImplementation(() => control.promise);
  const work = f.refresh();
  await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
  f.registry.detach('client');
  f.registry.reattach('client', f.session.transport);
  control.resolve(raw());
  expect(await work).toMatchObject({ reason: 'scope_changed' });
  expect(f.events.contextSnapshots.read('chat').revision).toBe(0);
});

it('exposes loading, partial evidence and expiry without converting stale capacity to free space', async () => {
  const f = fixture(),
    control = deferred<ReturnType<typeof raw>>();
  f.query.getContextUsage.mockImplementation(() => control.promise);
  const work = f.refresh();
  expect(f.lifecycle.inspect('chat').status).toBe('loading');
  control.resolve({ ...raw(), totalTokens: 70 });
  const result = await work;
  expect(result).toMatchObject({
    status: 'partial',
    snapshot: { reconciliation: { residualTokens: 10 } },
  });
  vi.useFakeTimers();
  vi.setSystemTime(result.snapshot!.observedAt + 30001);
  expect(f.lifecycle.read('chat')).toMatchObject({
    status: 'stale',
    reason: 'expired',
    snapshot: { capacity: { stale: true } },
  });
  expect(f.lifecycle.read('chat').snapshot!.capacity.freeTokens).toBeUndefined();
});

it.each(['local', 'openshell'] as const)(
  'persists Codex %s latest-request accounting without inventing occupancy',
  (placement) => {
    const f = fixture();
    f.owner.scope.binding.engine = 'codex';
    f.owner.scope.binding.placement = placement;
    f.owner.collect = undefined;
    const usage = {
      inputTokens: 50,
      outputTokens: 10,
      cachedInputTokens: 20,
      reasoningOutputTokens: 2,
      totalTokens: 60,
    };
    const snapshot = normalizeCodexContext(
      {
        threadId: 'thread',
        turnId: 'turn',
        tokenUsage: { last: usage, total: usage, modelContextWindow: 100 },
      },
      { ...f.owner.scope, observedAt: Date.now() },
    );
    expect(f.lifecycle.observe(f.owner, snapshot)).toBe(true);
    expect(f.lifecycle.read('chat').snapshot).toMatchObject({
      requestUsage: usage,
      measurement: { basis: 'latest-request' },
    });
    expect(f.lifecycle.read('chat').snapshot!.usedTokens).toBeUndefined();
    expect(f.query.getContextUsage).not.toHaveBeenCalled();
  },
);

it('keeps installed Local Codex evidence restored during passive lifecycle recovery', async () => {
  const f = fixture();
  const scope = structuredClone(f.owner.scope);
  scope.binding.engine = 'codex';
  const recovered = createRuntimeContextSnapshots(f.events, f.registry);
  const current = vi.fn(() => scope);
  const adapter = createCodexContextSnapshotAdapter({
    session: f.session,
    lifecycle: f.lifecycle,
    current,
    assertCurrent() {},
  });
  adapter.turnStarted();
  const usage = {
    inputTokens: 50,
    outputTokens: 10,
    cachedInputTokens: 20,
    reasoningOutputTokens: 2,
    totalTokens: 60,
  };
  adapter.usage({
    threadId: 'thread',
    turnId: 'turn',
    tokenUsage: { last: usage, total: usage, modelContextWindow: 100 },
  });
  const revision = f.events.contextSnapshots.read('chat').revision;
  expect(recovered.read('chat')).toMatchObject({ status: 'stale', reason: 'restored', revision });
  expect(recovered.inspect('chat').snapshot?.usedTokens).toBeUndefined();
  expect(
    await recovered.refresh(
      'chat',
      { requestId: randomUUID(), detail: 'summary' },
      f.authority,
      new AbortController().signal,
    ),
  ).toMatchObject({ reason: 'refresh_unsupported' });
  expect(f.events.contextSnapshots.read('chat').revision).toBe(revision);
  expect(f.session.contextSnapshotOwner?.scope).toEqual(scope);
  expect(f.query.getContextUsage).not.toHaveBeenCalled();
});

it('rejects invalid response envelopes and strips only additive fields', async () => {
  const f = fixture(),
    result = await f.refresh();
  expect(ContextSnapshotResponseSchema.parse({ ...result, future: true })).not.toHaveProperty(
    'future',
  );
  expect(ContextSnapshotResponseSchema.safeParse({ ...result, sessionId: 'other' }).success).toBe(
    false,
  );
  expect(ContextSnapshotResponseSchema.safeParse({ ...result, snapshot: undefined }).success).toBe(
    false,
  );
  expect(ContextSnapshotResponseSchema.safeParse({ ...result, version: 2 }).success).toBe(false);
  f.owner.scope.binding.accountRef = 'replacement';
  expect(f.lifecycle.forDelivery(result).snapshot).toBeUndefined();
});

it('records an authorized full result once and refuses conflicting reuse of its request identity', async () => {
  const f = fixture(),
    id = randomUUID();
  const first = await f.refresh({ detail: 'full', allowTokenCount: true, requestId: id });
  expect(first.snapshot!.measurement.method).toBe('claude-full');
  expect(await f.refresh({ detail: 'full', allowTokenCount: true, requestId: id })).toMatchObject({
    reason: 'superseded',
  });
  const otherAuthority = { ...f.authority, key: 'another-login' };
  expect(
    await f.refresh(
      { detail: 'full', allowTokenCount: true, requestId: id },
      undefined,
      otherAuthority,
    ),
  ).toMatchObject({ reason: 'request_conflict' });
  expect(f.query.getContextUsage).toHaveBeenCalledTimes(1);
});

it('keeps host write failures sanitized and preserves earlier observations', async () => {
  const f = fixture();
  await f.refresh();
  f.lifecycle.invalidate('chat', 'compacted');
  const save = vi.spyOn(f.events.contextSnapshots, 'save').mockImplementation(() => {
    throw Error('/private/prompt SECRET');
  });
  try {
    const response = await f.refresh();
    expect(response).toMatchObject({
      status: 'failed',
      reason: 'storage_failed',
      snapshot: { usedTokens: 60 },
    });
    expect(JSON.stringify(response)).not.toContain('SECRET');
  } finally {
    save.mockRestore();
  }
});
