import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskExecutionStore } from '../task-execution-store.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.useRealTimers();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'task-execution-'));
  cleanups.push(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'events.db');
  const store = new TaskExecutionStore(path);
  cleanups.push(() => store.close());
  const scope = {
    title: 'Implement PR',
    network: 'loopback' as const,
    repositories: ['owner/repo'],
    expiresAt: Date.now() + 60_000,
    members: [
      { sessionId: 'parent', fingerprint: 'parent-scope', roots: ['/task/parent'] },
      { sessionId: 'worker', fingerprint: 'worker-scope', roots: ['/task/worker'] },
    ],
  };
  return { path, store, scope };
}
it('persists one authorization for the selected workers and isolates operators', () => {
  const { path, store, scope } = fixture();
  const grant = store.approve('operator', 'parent', 'request', scope);
  const reopened = new TaskExecutionStore(path);
  cleanups.push(() => reopened.close());
  expect(reopened.active('operator', 'worker')[0].id).toBe(grant.id);
  expect(reopened.active('another-operator', 'worker')).toEqual([]);
  expect(reopened.active('operator', 'unselected-worker')).toEqual([]);
  expect(reopened.assertGrant(grant.id, 'operator', 'worker', 'worker-scope')).toEqual(grant);
  expect(() => reopened.assertGrant(grant.id, 'operator', 'worker', 'changed-root')).toThrow(
    /scope/,
  );
});
it('makes approval idempotent without treating a changed request as approved', () => {
  const { store, scope } = fixture();
  const first = store.approve('operator', 'parent', 'request', scope);
  expect(store.approve('operator', 'parent', 'request', scope)).toEqual(first);
  expect(() =>
    store.approve('operator', 'parent', 'request', { ...scope, network: 'internet' }),
  ).toThrow(/changed/);
});
it('revokes the shared task without a child retaining its old permission', () => {
  const { store, scope } = fixture();
  const grant = store.approve('operator', 'parent', 'request', scope);
  expect(() => store.revoke(grant.id, 'operator', 'worker')).toThrow(/owner/);
  store.revoke(grant.id, 'operator', 'parent');
  expect(() => store.assertGrant(grant.id, 'operator', 'worker', 'worker-scope')).toThrow(
    /revoked/,
  );
  expect(store.active('operator', 'worker')).toEqual([]);
});
it('refuses expired grants and retains run uncertainty across retries and restart', () => {
  const { store, path, scope } = fixture();
  const grant = store.approve('operator', 'parent', 'request', scope);
  expect(store.begin(grant.id, 'worker', 'run-1', 'command-hash')).toEqual({ state: 'running' });
  const reopened = new TaskExecutionStore(path);
  cleanups.push(() => reopened.close());
  expect(() => reopened.begin(grant.id, 'worker', 'run-1', 'command-hash')).toThrow(/uncertain/);
  expect(() => reopened.begin(grant.id, 'worker', 'run-1', 'different-command')).toThrow(/changed/);
  store.finish(grant.id, 'worker', 'run-1', { content: '3 passed', isError: false });
  expect(reopened.begin(grant.id, 'worker', 'run-1', 'command-hash')).toEqual({
    state: 'completed',
    result: { content: '3 passed', isError: false },
  });
  vi.useFakeTimers();
  vi.setSystemTime(scope.expiresAt);
  expect(() => store.assertGrant(grant.id, 'operator', 'worker', 'worker-scope')).toThrow(
    /expired/,
  );
});
