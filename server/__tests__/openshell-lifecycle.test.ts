import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
    gatewayEndpoint: null,
    sandboxName: 'mitzo-123',
    physicalSandboxId: 'physical-1',
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

it('rejects timer values that overflow Node timers and does not overwrite a newer record', () => {
  expect(() => openShellLifecyclePolicy({ MITZO_OPENSHELL_IDLE_MINUTES: '9999999999999' })).toThrow(
    'idle',
  );
  const store = setup();
  store.upsert(record({ generation: 2 }));
  expect(() => store.upsert(record({ generation: 1, phase: 'deleted' }))).toThrow('newer');
  expect(store.get('conversation')).toMatchObject({ generation: 2, phase: 'stopped' });
  store.close();
});

it('defaults retention to seven days and permits a five-day minimum', () => {
  expect(openShellLifecyclePolicy({}).retentionMs).toBe(7 * DAY);
  expect(openShellLifecyclePolicy({ MITZO_OPENSHELL_RETENTION_DAYS: '5' }).retentionMs).toBe(
    5 * DAY,
  );
  expect(openShellLifecyclePolicy({ MITZO_OPENSHELL_RETENTION_DAYS: '30' }).retentionMs).toBe(
    30 * DAY,
  );
  expect(openShellLifecyclePolicy({ MITZO_OPENSHELL_RETENTION_DAYS: '40000' }).retentionMs).toBe(
    40000 * DAY,
  );
  for (const value of [
    '0',
    '-1',
    '4.9',
    '5.5',
    'nope',
    'Infinity',
    String(Math.floor(Number.MAX_SAFE_INTEGER / DAY) + 1),
  ])
    expect(() => openShellLifecyclePolicy({ MITZO_OPENSHELL_RETENTION_DAYS: value })).toThrow(
      'retention',
    );
});

it('keeps Node timer bounds on minute-based lifecycle intervals', () => {
  const maxTimerMinutes = Math.floor((2 ** 31 - 1) / 60_000);
  expect(
    openShellLifecyclePolicy({ MITZO_OPENSHELL_IDLE_MINUTES: String(maxTimerMinutes) }),
  ).toMatchObject({
    idleMs: maxTimerMinutes * 60_000,
  });
  for (const env of [
    { MITZO_OPENSHELL_IDLE_MINUTES: String(maxTimerMinutes + 1) },
    { MITZO_OPENSHELL_RECONCILE_MINUTES: String(maxTimerMinutes + 1) },
    { MITZO_OPENSHELL_IDLE_MINUTES: '1.5' },
  ])
    expect(() => openShellLifecyclePolicy(env)).toThrow();
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

it('keeps an explicit reservation until the caller releases it', async () => {
  const coordinator = new OpenShellLifecycleCoordinator();
  const release = await coordinator.reserve('conversation');
  let entered = false;
  const pending = coordinator.admit('conversation', async () => {
    entered = true;
  });
  await Promise.resolve();
  expect(entered).toBe(false);
  release();
  await pending;
  expect(entered).toBe(true);
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

it('synchronously invalidates a pending stop when queue activity arrives', () => {
  const coordinator = new OpenShellLifecycleCoordinator();
  const before = coordinator.activityGeneration('conversation');
  expect(coordinator.noteActivity('conversation')).toBe(before + 1);
  expect(coordinator.activityGeneration('conversation')).toBe(before + 1);
});

it('reports idle cleanup failure instead of swallowing it', async () => {
  const failure = vi.fn();
  const coordinator = new OpenShellLifecycleCoordinator({ onIdleError: failure });
  coordinator.scheduleIdle('conversation', 0, () => Promise.reject(new Error('stop failed')));
  await vi.waitFor(() => expect(failure).toHaveBeenCalledWith('conversation', expect.any(Error)));
});
