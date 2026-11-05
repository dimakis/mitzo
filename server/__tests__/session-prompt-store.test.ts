import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionPromptStore } from '../session-prompt-store.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const auth = { id: 'signed-login', expiresAt: 10_000_000 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-prompts-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  const store = new SessionPromptStore(path);
  cleanup.push(() => store.close());
  const input = {
    requestId: randomUUID(),
    sessionId: 'worker',
    prompt: 'Check PR #7',
    intervalMinutes: 10,
    startImmediately: false,
    maxRuns: null,
  };
  return { store, path, input };
}

it('retains exact timer creation and attribution across restart without returning login material', () => {
  const f = fixture();
  const first = f.store.create(f.input, auth, 'agent', 'coordinator', 1000);
  expect(first).toMatchObject({
    revision: 1,
    status: 'active',
    nextRunAt: 601000,
    createdBy: 'agent',
    sourceSessionId: 'coordinator',
    runCount: 0,
  });
  expect(f.store.create(f.input, auth, 'agent', 'coordinator', 2000)).toEqual(first);
  expect(() =>
    f.store.create({ ...f.input, prompt: 'Different work' }, auth, 'agent', 'coordinator', 2000),
  ).toThrow(/identity/i);
  expect(JSON.stringify(first)).not.toContain('signed-login');
  const reopened = new SessionPromptStore(f.path);
  cleanup.push(() => reopened.close());
  expect(reopened.list()).toEqual([first]);
});

it('coalesces overdue intervals into one stable pending delivery and fences edits and cancellation', () => {
  const { store, input } = fixture();
  const timer = store.create(input, auth, 'user', null, 0);
  const delivery = store.due(6_000_000)[0];
  expect(delivery).toMatchObject({
    timerId: timer.id,
    recipientSessionId: 'worker',
    state: 'pending',
  });
  expect(store.due(12_000_000)).toEqual([delivery]);
  expect(store.claim(delivery.id)).toBe(true);
  expect(store.claim(delivery.id)).toBe(false);
  const cancelled = store.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: 1, action: 'cancel' },
    auth,
    12_000_000,
  );
  expect(cancelled).toMatchObject({ status: 'cancelled', nextRunAt: null });
  expect(() => store.assertDeliveryCurrent(delivery.id)).toThrow(/cancel|current/i);
  expect(store.due(20_000_000)).toEqual([]);
  expect(() =>
    store.change(
      timer.id,
      { requestId: randomUUID(), expectedRevision: 1, action: 'resume' },
      auth,
      12_000_000,
    ),
  ).toThrow(/changed/i);
});

it('counts accepted prompts rather than model task completion and stops at the run limit', () => {
  const { store, input } = fixture();
  const timer = store.create(
    { ...input, maxRuns: 1, startImmediately: true },
    auth,
    'user',
    null,
    1000,
  );
  const delivery = store.due(1000)[0];
  store.claim(delivery.id);
  store.finish(delivery.id, 'accepted', null, 1000);
  store.finish(delivery.id, 'accepted', null, 2000);
  expect(store.get(timer.id)).toMatchObject({
    status: 'completed',
    runCount: 1,
    lastRunAt: 1000,
    nextRunAt: null,
  });
  expect(store.due(5_000_000)).toEqual([]);
});

it('preserves pause/cancel after a runtime acknowledgement races with a human action', () => {
  const { store, input } = fixture();
  const timer = store.create({ ...input, startImmediately: true }, auth, 'user', null, 0);
  const delivery = store.due(0)[0];
  store.claim(delivery.id);
  store.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: 1, action: 'pause' },
    auth,
    10,
  );
  store.finish(delivery.id, 'accepted', null, 20);
  expect(store.get(timer.id)).toMatchObject({ status: 'paused', nextRunAt: null, runCount: 1 });
});

it('blocks uncertain delivery and resumes with a fresh login only through an explicit revisioned command', () => {
  const { store, input } = fixture();
  const timer = store.create({ ...input, startImmediately: true }, auth, 'user', null, 0);
  const delivery = store.due(0)[0];
  store.claim(delivery.id);
  store.finish(delivery.id, 'uncertain', 'Check delivery before resuming.', 20);
  const blocked = store.get(timer.id);
  expect(blocked).toMatchObject({ status: 'blocked', nextRunAt: null, runCount: 0 });
  expect(() =>
    store.change(
      timer.id,
      { requestId: randomUUID(), expectedRevision: blocked.revision, action: 'resume' },
      auth,
      30,
    ),
  ).toThrow(/uncertain/i);
  store.finish(delivery.id, 'accepted', null, 40);
  const reconciled = store.get(timer.id);
  store.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: reconciled.revision, action: 'resume' },
    { id: 'new-login', expiresAt: 20_000_000 },
    50,
  );
  expect(store.get(timer.id)).toMatchObject({ status: 'active', nextRunAt: 600050, runCount: 1 });
});

it('retains agent callback identity and rejects changed recipients or source identity on retry', () => {
  const { store } = fixture();
  const input = {
    requestId: randomUUID(),
    sessionId: 'coordinator',
    text: 'Task T is complete.',
    workId: 'T',
  };
  const first = store.message(input, auth, 'worker', 0);
  expect(first).toMatchObject({
    kind: 'agent',
    senderSessionId: 'worker',
    recipientSessionId: 'coordinator',
    workId: 'T',
  });
  expect(store.message(input, auth, 'worker', 10)).toEqual(first);
  expect(() => store.message({ ...input, sessionId: 'someone-else' }, auth, 'worker', 10)).toThrow(
    /identity/i,
  );
  expect(() => store.message(input, auth, 'pretend-worker', 10)).toThrow(/identity/i);
  expect(() =>
    store.message({ ...input, requestId: randomUUID(), sessionId: 'worker' }, auth, 'worker', 10),
  ).toThrow(/another/i);
});

it('validates timer bounds and keeps run-now distinct from recurring schedule identity', () => {
  const { store, input } = fixture();
  expect(() => store.create({ ...input, intervalMinutes: 0 }, auth, 'user', null, 0)).toThrow();
  expect(() => store.create({ ...input, prompt: ' ' }, auth, 'user', null, 0)).toThrow();
  const timer = store.create(input, auth, 'user', null, 0);
  const request = {
    requestId: randomUUID(),
    expectedRevision: timer.revision,
    action: 'run' as const,
  };
  store.change(timer.id, request, auth, 1);
  const first = store.due(1)[0];
  store.change(timer.id, request, auth, 2);
  expect(store.due(2)).toEqual([first]);
});
