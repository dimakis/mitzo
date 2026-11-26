import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContextSnapshotScope } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { SessionRegistry } from '../session-registry.js';
import { createRuntimeContextSnapshots } from '../context-snapshot-runtime.js';
import { createCodexContextSnapshotAdapter } from '../codex-context-snapshot.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const events = new EventStore(':memory:');
  cleanup.push(() => events.close());
  events.upsertSession({ sessionId: 'chat', cwd: '/offline' });
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  registry.register('client', {
    sessionId: 'chat',
    transport: { isOpen: () => true, send() {} },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const session = registry.get('client')!;
  const lifecycle = createRuntimeContextSnapshots(events, registry);
  let scope: ContextSnapshotScope | undefined = {
    identity: {
      sessionId: 'chat',
      threadId: 'thread',
      turnId: 'turn',
      scope: 'parent',
      ownerGeneration: 'generation',
    },
    binding: {
      engine: 'codex',
      placement: 'local',
      model: 'fixture-model',
      accountRef: 'personal',
      runtimeBindingRevision: 'runtime',
    },
  };
  const assertCurrent = vi.fn();
  const adapter = createCodexContextSnapshotAdapter({
    session,
    lifecycle,
    current: () => scope,
    assertCurrent,
  });
  adapter.turnStarted();
  const notify = (total = 10, overrides = {}) =>
    adapter.usage({
      threadId: 'thread',
      turnId: 'turn',
      tokenUsage: {
        total: {
          inputTokens: total,
          cachedInputTokens: 2,
          outputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: total + 2,
        },
        last: {
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 7,
        },
        modelContextWindow: 100,
      },
      ...overrides,
    });
  return {
    events,
    registry,
    session,
    lifecycle,
    adapter,
    notify,
    assertCurrent,
    scope: () => scope!,
    replace: (next?: ContextSnapshotScope) => {
      scope = next;
    },
  };
}

it('installs an event-only owner and keeps latest-request tokens out of occupancy', async () => {
  const f = fixture();
  f.notify();
  expect(f.session.contextSnapshotOwner?.collect).toBeUndefined();
  const snapshot = f.events.contextSnapshots.read('chat').snapshot!;
  expect(snapshot).toMatchObject({
    requestUsage: { totalTokens: 7 },
    freshness: { state: 'unknown' },
    categories: [],
    contributions: [],
  });
  expect(snapshot.usedTokens).toBeUndefined();
  expect(snapshot.capacity.freeTokens).toBeUndefined();
  expect(
    await f.lifecycle.refresh(
      'chat',
      { requestId: randomUUID(), detail: 'summary' },
      {
        key: 'operator',
        current: () => true,
        allowTokenCount: async () => true,
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ reason: 'refresh_unsupported' });
});

it('fences wrong identities, duplicate/late usage, compaction and terminal observations', () => {
  const f = fixture();
  f.notify(10, { threadId: 'other' });
  f.notify(10, { turnId: 'other' });
  expect(f.events.contextSnapshots.read('chat').snapshot).toBeUndefined();
  f.notify();
  const saved = f.events.contextSnapshots.read('chat');
  f.notify();
  f.notify(9);
  expect(f.events.contextSnapshots.read('chat')).toEqual(saved);
  f.adapter.invalidate('compacted');
  f.notify();
  expect(f.lifecycle.read('chat').reason).toBe('compacted');
  f.notify(11);
  expect(f.events.contextSnapshots.read('chat').reason).toBeUndefined();
  f.adapter.invalidate('turn_completed');
  f.replace();
  f.notify(12);
  expect(f.lifecycle.read('chat').reason).toBe('turn_completed');
});

it.each(['account', 'model', 'runtime', 'turn'] as const)(
  'retires %s replacement without acquiring anything on inspection',
  (replacement) => {
    const f = fixture();
    f.notify();
    const previous = f.session.contextSnapshotOwner;
    const scope = structuredClone(f.scope());
    if (replacement === 'account') scope.binding.accountRef = 'another';
    if (replacement === 'model') scope.binding.model = 'another';
    if (replacement === 'runtime') scope.identity.ownerGeneration = 'another';
    if (replacement === 'turn') scope.identity.turnId = 'another';
    f.replace(scope);
    expect(f.lifecycle.read('chat').status).toBe('stale');
    f.notify(11);
    expect(f.events.contextSnapshots.read('chat').snapshot?.requestUsage?.totalTokens).toBe(7);
    f.adapter.turnStarted();
    expect(f.session.contextSnapshotOwner).not.toBe(previous);
    expect(f.lifecycle.read('chat').snapshot).toBeUndefined();
  },
);

it('does not reverify duplicate evidence after detach/reconnect and refuses revoked authority', () => {
  const f = fixture();
  f.notify();
  f.registry.detach('client');
  f.notify(11);
  expect(f.events.contextSnapshots.read('chat').snapshot?.requestUsage?.totalTokens).toBe(7);
  f.registry.reattach('client', { isOpen: () => true, send() {} });
  f.notify();
  expect(f.lifecycle.read('chat').reason).toBe('restored');
  f.notify(12);
  f.assertCurrent.mockImplementation(() => {
    throw Error('revoked private diagnostic');
  });
  f.notify(13);
  expect(f.lifecycle.read('chat')).toMatchObject({ status: 'stale', reason: 'authority_expired' });
});

it('never installs an unqualified OpenShell owner', () => {
  const f = fixture();
  f.replace({ ...f.scope(), binding: { ...f.scope().binding, placement: 'openshell' } });
  f.adapter.turnStarted();
  f.notify();
  expect(f.session.contextSnapshotOwner?.state).not.toBe('active');
  expect(f.events.contextSnapshots.read('chat').snapshot).toBeUndefined();
});
