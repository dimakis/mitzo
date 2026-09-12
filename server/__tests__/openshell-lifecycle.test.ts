import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  OpenShellLifecycleStore,
  OpenShellLifecycleCoordinator,
  openShellLifecyclePolicy,
  type OpenShellLifecycleRecord,
} from '../openshell-lifecycle.js';

const roots: string[] = [];
const DAY = 24 * 60 * 60 * 1000;
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-openshell-lifecycle-'));
  roots.push(root);
  return new OpenShellLifecycleStore(join(root, 'lifecycle.db'));
}
function record(overrides: Partial<OpenShellLifecycleRecord> = {}): OpenShellLifecycleRecord {
  return {
    conversationId: 'conversation',
    workspace: 'default',
    gateway: 'openshell',
    sandboxName: 'mitzo-123',
    accountProvider: 'provider',
    phase: 'stopped',
    generation: 1,
    lastActivityAt: 100,
    idleSince: 200,
    stoppedAt: 300,
    checkpoint: null,
    ...overrides,
  };
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

it('defaults retention to seven days and permits a five-day minimum', () => {
  expect(openShellLifecyclePolicy({}).retentionMs).toBe(7 * DAY);
  expect(openShellLifecyclePolicy({ MITZO_OPENSHELL_RETENTION_DAYS: '5' }).retentionMs).toBe(
    5 * DAY,
  );
  for (const value of ['0', '-1', '4.9', 'nope', 'Infinity'])
    expect(() => openShellLifecyclePolicy({ MITZO_OPENSHELL_RETENTION_DAYS: value })).toThrow(
      'retention',
    );
});

it('requires a confirmed stopped timestamp before retention eligibility', () => {
  const policy = openShellLifecyclePolicy({ MITZO_OPENSHELL_RETENTION_DAYS: '5' });
  expect(policy.retentionEligible(record({ stoppedAt: null }), 300 + 100 * DAY)).toBe(false);
  expect(policy.retentionEligible(record(), 300 + 5 * DAY - 1)).toBe(false);
  expect(policy.retentionEligible(record(), 300 + 5 * DAY)).toBe(true);
});

it('persists records across restart and uses a generation CAS for mutations', () => {
  const store = setup();
  store.upsert(record());
  expect(store.transition('conversation', 1, 'checkpointing')).toMatchObject({
    phase: 'checkpointing',
    generation: 2,
  });
  expect(store.transition('conversation', 1, 'stopping')).toBeNull();
  store.close();
  const reopened = new OpenShellLifecycleStore(roots.at(-1)! + '/lifecycle.db');
  expect(reopened.get('conversation')).toMatchObject({ phase: 'checkpointing', generation: 2 });
  reopened.close();
});

it('does not lose explicit failure state during startup reconciliation', () => {
  const store = setup();
  store.upsert(record({ phase: 'deleting' }));
  store.reconcileInterrupted();
  expect(store.get('conversation')).toMatchObject({
    phase: 'failed',
    failure: 'interrupted lifecycle action',
  });
  store.close();
});

it('serializes admission for the same conversation without blocking other conversations', async () => {
  const coordinator = new OpenShellLifecycleCoordinator();
  const events: string[] = [];
  let release!: () => void;
  const first = coordinator.admit('one', async () => {
    events.push('one:start');
    await new Promise<void>((resolve) => (release = resolve));
    events.push('one:end');
  });
  await Promise.resolve();
  const second = coordinator.admit('one', async () => events.push('two'));
  const other = coordinator.admit('other', async () => events.push('other'));
  await other;
  expect(events).toEqual(['one:start', 'other']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['one:start', 'other', 'one:end', 'two']);
});

it('cancels a scheduled idle action when new work is admitted', async () => {
  const coordinator = new OpenShellLifecycleCoordinator();
  let called = false;
  coordinator.scheduleIdle('conversation', 0, () => {
    called = true;
    return Promise.resolve();
  });
  await coordinator.admit('conversation', async () => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(called).toBe(false);
});
