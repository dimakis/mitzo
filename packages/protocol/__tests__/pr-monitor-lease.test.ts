import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { EventStore } from '../src/event-store.js';
import { PR_MONITOR_CLAIM_TTL_MS } from '../src/pr-monitor-lease.js';
import {
  subscription,
  snapshot,
  finding,
  watch,
} from '../../../server/__tests__/fixtures/pr-monitor.js';

const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-lease-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, 'events.sqlite');
  const open = () => {
    const store = new EventStore(path);
    // Bound the deliberate contention test; production retains its owner timeout.
    (store as unknown as { db: Database.Database }).db.pragma('busy_timeout=0');
    cleanup.push(() => store.close());
    return store;
  };
  const a = open(),
    b = open();
  const sql = new Database(path);
  sql.pragma('busy_timeout=0');
  cleanup.push(() => sql.close());
  const s = subscription();
  a.upsertSession({ sessionId: s.conversationId });
  a.prMonitor.create('create', s);
  const view = () => a.prMonitor.read(s.operatorId, s.conversationId, s.id);
  const acquire = (store = a, now = 1000) =>
    store.prMonitor.leases.acquire(view().subscription, now)!;
  const publish = (claim: ReturnType<typeof acquire>, now = 1000, expectedSnapshotRevision = 0) =>
    b.prMonitor.publish({
      operatorId: s.operatorId,
      conversationId: s.conversationId,
      subscriptionId: s.id,
      expectedRevision: view().subscription.revision,
      expectedSnapshotRevision,
      snapshot: { ...snapshot, observedAt: now },
      findings: [finding],
      baseline: false,
      assertCurrent: () => undefined,
      claim,
      now: () => now,
    });
  const fail = (claim: ReturnType<typeof acquire>, now = 1000, expectedSnapshotRevision = 0) =>
    b.prMonitor.fail({
      operatorId: s.operatorId,
      conversationId: s.conversationId,
      subscriptionId: s.id,
      expectedRevision: view().subscription.revision,
      expectedSnapshotRevision,
      diagnostic: { code: 'incomplete', stage: 'read', nextRefreshAt: now + 60000 },
      claim,
      now: () => now,
    });
  return { a, b, sql, s, view, acquire, publish, fail, open, path };
}
it('admits exactly one simultaneous acquisition from two independent EventStore workers', async () => {
  const f = fixture();
  const barrier = new SharedArrayBuffer(4);
  const contenders: Promise<{ claim?: unknown; error?: Error }>[] = [];
  // Initialize EventStore's startup migrations sequentially. The barrier then
  // releases both independent handles for simultaneous claim acquisition.
  for (let i = 0; i < 2; i++) {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { register } = await import('tsx/esm/api');
        register();
        const { EventStore } = await import(workerData.url);
        const store = new EventStore(workerData.path);
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        const claim = store.prMonitor.leases.acquire(workerData.subscription, 1000);
        store.close();
        parentPort.postMessage({ claim });
      })();`,
      {
        eval: true,
        workerData: {
          path: f.path,
          subscription: f.s,
          barrier,
          url: new URL('../src/event-store.ts', import.meta.url).href,
        },
      },
    );
    cleanup.push(() => worker.terminate());
    const ready = new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (value) => {
        if (value === 'ready') resolve();
      });
    });
    const result = new Promise<{ claim?: unknown; error?: Error }>((resolve) => {
      worker.once('error', (error) => resolve({ error }));
      worker.on('message', (value) => {
        if (value !== 'ready') resolve(value);
      });
    });
    contenders.push(result);
    await ready;
  }
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0);
  const results = await Promise.all(contenders);
  for (const result of results) if (result.error) throw result.error;
  expect(results.filter((result) => result.claim)).toHaveLength(1);
});
it('serializes two independent owners and permits independent subscription claims', async () => {
  const f = fixture();
  const claims = await Promise.all([f.a, f.b].map(async (store) => f.acquire(store)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims.find(Boolean)!;
  expect(winner.ownerToken).toBeTruthy();
  const other = subscription();
  f.b.prMonitor.create('other', other);
  expect(f.b.prMonitor.leases.acquire(other, 1000)).not.toBeNull();
  expect(() => f.a.prMonitor.leases.assert({ ...winner, operatorId: 'other' }, 1000)).toThrow(
    'observation_claim_lost',
  );
  expect(f.b.prMonitor.leases.release({ ...winner, ownerToken: 'forged' })).toBe(false);
  expect(() => f.b.prMonitor.leases.assert(winner, 1000)).not.toThrow();
});
it('retains crash custody through reopen and fences expired success, failure and release after takeover', () => {
  const f = fixture();
  const old = f.acquire();
  f.a.close();
  const reopened = f.open();
  expect(reopened.prMonitor.leases.acquire(f.s, 1001)).toBeNull();
  const now = 1000 + PR_MONITOR_CLAIM_TTL_MS;
  const successor = reopened.prMonitor.leases.acquire(f.s, now)!;
  expect(successor.generation).toBeGreaterThan(old.generation);
  expect(successor.ownerToken).not.toBe(old.ownerToken);
  const result = f.b.prMonitor.publish({
    operatorId: f.s.operatorId,
    conversationId: f.s.conversationId,
    subscriptionId: f.s.id,
    expectedRevision: 1,
    expectedSnapshotRevision: 0,
    snapshot: { ...snapshot, observedAt: now },
    findings: [finding],
    baseline: false,
    assertCurrent: () => undefined,
    claim: successor,
    now: () => now,
  });
  expect(() =>
    f.b.prMonitor.publish({
      operatorId: f.s.operatorId,
      conversationId: f.s.conversationId,
      subscriptionId: f.s.id,
      expectedRevision: 1,
      expectedSnapshotRevision: 1,
      snapshot,
      findings: [],
      baseline: false,
      assertCurrent: () => undefined,
      claim: old,
      now: () => now,
    }),
  ).toThrow('observation_claim_lost');
  expect(() =>
    f.b.prMonitor.fail({
      operatorId: f.s.operatorId,
      conversationId: f.s.conversationId,
      subscriptionId: f.s.id,
      expectedRevision: 1,
      expectedSnapshotRevision: 1,
      claim: old,
      now: () => now,
      diagnostic: { code: 'incomplete', stage: 'read', nextRefreshAt: now + 60000 },
    }),
  ).toThrow('observation_claim_lost');
  expect(reopened.prMonitor.leases.release(old)).toBe(false);
  expect(f.b.prMonitor.read(f.s.operatorId, f.s.conversationId, f.s.id)).toEqual(result);
  expect(result.outbox?.eventIds).toHaveLength(1);
});
it('checks snapshot revision inside the failure transaction and rolls back final custody loss', () => {
  const f = fixture();
  const claim = f.acquire();
  const published = f.publish(claim);
  expect(() => f.fail(claim)).toThrow('revision_conflict');
  expect(f.view()).toEqual(published);
  f.a.prMonitor.leases.release(claim);
  const next = f.acquire();
  let now = 1000;
  expect(() =>
    f.b.prMonitor.publish({
      operatorId: f.s.operatorId,
      conversationId: f.s.conversationId,
      subscriptionId: f.s.id,
      expectedRevision: 1,
      expectedSnapshotRevision: 1,
      snapshot,
      findings: [],
      baseline: false,
      claim: next,
      now: () => now,
      assertCurrent: () => {
        now += PR_MONITOR_CLAIM_TTL_MS;
      },
    }),
  ).toThrow('observation_claim_lost');
  expect(f.view()).toEqual(published);
  // Expiry observed by a rolled-back final fence must still retain its clock
  // high-water mark; a subsequent backward clock cannot grant early custody.
  expect(f.acquire(f.b, 1001)).toBeNull();
});
it.each(['stopped', 'deleted', 'renew', 'revoke'] as const)(
  'invalidates claims durably on %s',
  (change) => {
    const f = fixture();
    watch(f.a.prMonitor, f.s);
    const claim = f.acquire();
    const s = f.view().subscription;
    if (change === 'renew') watch(f.b.prMonitor, s);
    else if (change === 'revoke')
      f.b.prMonitor.beginWatchRevocation({
        requestId: 'revoke',
        fingerprint: 'revoke',
        operatorId: s.operatorId,
        conversationId: s.conversationId,
        subscriptionId: s.id,
        expectedRevision: s.revision,
        expectedAuthorityRevision: s.watch!.revision,
        assertCurrent: () => undefined,
      });
    else f.b.prMonitor.stopConversation(s.conversationId, change);
    const retained = f.view();
    expect(() => f.a.prMonitor.leases.assert(claim, 1001)).toThrow('observation_claim_lost');
    expect(() => f.fail(claim, 1001)).toThrow('observation_claim_lost');
    expect(f.view()).toEqual(retained);
  },
);
it('does not grant custody on SQLite failure and rolls back failed publication without clearing its successor', () => {
  const f = fixture();
  f.sql.exec(
    "CREATE TRIGGER reject_claim BEFORE INSERT ON pr_monitor_leases BEGIN SELECT RAISE(ABORT, 'injected_claim_failure'); END",
  );
  expect(() => f.acquire()).toThrow('injected_claim_failure');
  expect(f.sql.prepare('SELECT count(*) n FROM pr_monitor_leases').get()).toEqual({ n: 0 });
  f.sql.exec('DROP TRIGGER reject_claim');
  const claim = f.acquire();
  f.sql.exec(
    "CREATE TRIGGER reject_publish BEFORE UPDATE ON pr_monitor_subscriptions BEGIN SELECT RAISE(ABORT, 'injected_publish_failure'); END",
  );
  expect(() => f.publish(claim)).toThrow('injected_publish_failure');
  expect(f.view().snapshot).toBeNull();
  f.sql.exec('DROP TRIGGER reject_publish');
  expect(() => f.a.prMonitor.leases.assert(claim, 1000)).not.toThrow();
  f.sql.exec('BEGIN IMMEDIATE');
  try {
    expect(() => f.b.prMonitor.leases.release(claim)).toThrow(/locked|busy/i);
  } finally {
    f.sql.exec('ROLLBACK');
  }
  expect(() => f.a.prMonitor.leases.assert(claim, 1000)).not.toThrow();
});
it('fails conservatively on expiry, backward/invalid clocks and does not revive poisoned tokens', () => {
  const f = fixture();
  const claim = f.acquire();
  f.b.prMonitor.leases.assert(claim, 2000);
  expect(() => f.a.prMonitor.leases.assert(claim, 1999)).toThrow('observation_claim_lost');
  expect(() => f.b.prMonitor.leases.assert(claim, 2000)).toThrow('observation_claim_lost');
  expect(f.acquire(f.b, 1999)).toBeNull();
  const next = f.acquire(f.b, 2000);
  expect(next.generation).toBeGreaterThan(claim.generation);
  expect(() => f.a.prMonitor.leases.assert(next, 2000 + PR_MONITOR_CLAIM_TTL_MS)).toThrow(
    'observation_claim_lost',
  );
  expect(() => f.a.prMonitor.leases.assert(next, 2001)).toThrow('observation_claim_lost');
  expect(() => f.acquire(f.b, NaN)).toThrow('invalid_observation_clock');
});
it('keeps one bounded row and monotonic generations across many acquisitions and releases', () => {
  const f = fixture();
  let generation = 0;
  for (let i = 0; i < 50; i++) {
    const claim = f.acquire(i % 2 ? f.a : f.b, 1000 + i);
    expect(claim.generation).toBeGreaterThan(generation);
    generation = claim.generation;
    expect(f.b.prMonitor.leases.release(claim)).toBe(true);
    expect(f.a.prMonitor.leases.release(claim)).toBe(false);
  }
  expect(f.sql.prepare('SELECT count(*) n FROM pr_monitor_leases').get()).toEqual({ n: 1 });
});
it('grants no claim under SQLITE_BUSY and rolls back both failure and revocation writes', () => {
  const f = fixture();
  f.sql.exec('BEGIN IMMEDIATE');
  try {
    expect(() => f.acquire(f.b)).toThrow(/locked|busy/i);
  } finally {
    f.sql.exec('ROLLBACK');
  }
  expect(f.sql.prepare('SELECT count(*) n FROM pr_monitor_leases').get()).toEqual({ n: 0 });
  watch(f.a.prMonitor, f.s);
  const claim = f.acquire();
  const published = f.publish(claim);
  f.sql.exec(
    "CREATE TRIGGER reject_change BEFORE UPDATE ON pr_monitor_subscriptions BEGIN SELECT RAISE(ABORT, 'injected_rollback'); END",
  );
  expect(() => f.fail(claim, 1000, 1)).toThrow('injected_rollback');
  const s = f.view().subscription;
  expect(() =>
    f.b.prMonitor.beginWatchRevocation({
      requestId: 'revoke',
      fingerprint: 'revoke',
      operatorId: s.operatorId,
      conversationId: s.conversationId,
      subscriptionId: s.id,
      expectedRevision: s.revision,
      expectedAuthorityRevision: s.watch!.revision,
      assertCurrent: () => undefined,
    }),
  ).toThrow('injected_rollback');
  expect(f.view()).toEqual(published);
  expect(f.a.prMonitor.pendingWatchRevocation(s.id)).toBeNull();
  expect(() => f.b.prMonitor.leases.assert(claim, 1000)).not.toThrow();
});
it('rolls failure publication back when its final claim fence expires', () => {
  const f = fixture();
  const claim = f.acquire();
  const before = f.publish(claim);
  let clocks = 0;
  expect(() =>
    f.b.prMonitor.fail({
      operatorId: f.s.operatorId,
      conversationId: f.s.conversationId,
      subscriptionId: f.s.id,
      expectedRevision: 1,
      expectedSnapshotRevision: 1,
      claim,
      now: () => (++clocks < 3 ? 1000 : 1000 + PR_MONITOR_CLAIM_TTL_MS),
      diagnostic: { code: 'incomplete', stage: 'read', nextRefreshAt: 61000 },
    }),
  ).toThrow('observation_claim_lost');
  expect(f.view()).toEqual(before);
  expect(f.acquire(f.b, 1001)).toBeNull();
});
