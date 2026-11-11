import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '@mitzo/protocol/event-store';
import {
  expectRetainedAttemptUnchanged,
  type ObservedTransportRefresh,
} from './fixtures/retained-attempt.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.upsertSession({ sessionId: 'original', summary: 'Running reviewed attempt' });
  store.setSessionState('original', 'ACTIVE', { force: true });
  const read = () => ({
    session: store.getSession('original')!,
    context: { brief: 'Original reviewed brief' },
    native: { commandId: 'original-command', status: 'running', turns: 1 },
    runtime: { accountId: 'synthetic-account', model: 'offline-model' },
    workspace: { id: 'original-workspace', directory: '/synthetic/original' },
  });
  const original = structuredClone(read());
  let now = Date.now();
  const refresh = (state: 'ACTIVE' | 'DETACHED', reason: string): ObservedTransportRefresh => {
    const before = structuredClone(read().session);
    vi.spyOn(Date, 'now').mockReturnValue((now += 12_313));
    store.setSessionState('original', state, { reason });
    return { state, reason, before, after: structuredClone(read().session) };
  };
  return { original, read, refresh };
}

it.each([false, true])(
  'keeps the complete retained attempt through real lifecycle writes (detach=%s)',
  (detach) => {
    const f = fixture();
    const writes = detach ? [f.refresh('DETACHED', 'transport_close')] : [];
    writes.push(f.refresh('ACTIVE', 'reattach'));
    // The old whole-session assertion reproduces the hosted timestamp failure.
    expect(f.read()).not.toEqual(f.original);
    expectRetainedAttemptUnchanged(f.original, f.read(), writes);
  },
);

it.each(['session', 'context', 'native', 'runtime', 'workspace'] as const)(
  'still rejects a changed %s after an otherwise valid reattachment',
  (field) => {
    const f = fixture();
    const writes = [f.refresh('ACTIVE', 'reattach')];
    const changed = f.read();
    Object.assign(changed[field], { unexpectedMutation: 'must stay visible' });
    expect(() => expectRetainedAttemptUnchanged(f.original, changed, writes)).toThrow();
  },
);

it('rejects an unwitnessed timestamp refresh', () => {
  const f = fixture();
  f.refresh('ACTIVE', 'reattach');
  expect(() => expectRetainedAttemptUnchanged(f.original, f.read(), [])).toThrow();
});

it('rejects a different lifecycle reason even with the same final state', () => {
  const f = fixture();
  const writes = [f.refresh('ACTIVE', 'unexpected_writer')];
  expect(() => expectRetainedAttemptUnchanged(f.original, f.read(), writes)).toThrow();
});

it('rejects unrelated mutation inside a witnessed lifecycle write', () => {
  const f = fixture();
  const writes = [f.refresh('ACTIVE', 'reattach')];
  writes[0].after.summary = 'Different attempt';
  const changed = f.read();
  changed.session.summary = writes[0].after.summary;
  expect(() => expectRetainedAttemptUnchanged(f.original, changed, writes)).toThrow();
});

it('rejects an incomplete detach and an out-of-order lifecycle history', () => {
  const f = fixture();
  const detached = f.refresh('DETACHED', 'transport_close');
  expect(() => expectRetainedAttemptUnchanged(f.original, f.read(), [detached])).toThrow();
  const attached = f.refresh('ACTIVE', 'reattach');
  expect(() =>
    expectRetainedAttemptUnchanged(f.original, f.read(), [attached, detached]),
  ).toThrow();
});
