import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../../packages/protocol/src/event-store.js';
import { subscription, watch } from './fixtures/pr-monitor.js';
import { PR_MONITOR_CLAIM_TTL_MS } from '../../packages/protocol/src/pr-monitor-lease.js';
import { PrMonitorObserver, type PrMonitorReadPort } from '../pr-monitor-observer.js';
import { PrMonitorConsent } from '../pr-monitor-consent.js';
import { createPrMonitorObservationRuntime } from '../pr-monitor-runtime.js';
const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => logs }));

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'observer-lease-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.sqlite');
  const a = new EventStore(path),
    b = new EventStore(path);
  cleanup.push(() => {
    a.close();
    b.close();
  });
  const sql = new Database(path);
  cleanup.push(() => {
    sql.close();
  });
  for (const store of [a, b])
    (store as unknown as { db: Database.Database }).db.pragma('busy_timeout=0');
  let now = Date.now();
  const s = subscription();
  a.upsertSession({ sessionId: s.conversationId });
  a.prMonitor.create('create', s);
  watch(a.prMonitor, s, now);
  const view = () => b.prMonitor.read(s.operatorId, s.conversationId, s.id);
  let headSha = 'a'.repeat(40);
  const read = vi.fn<PrMonitorReadPort>(async (request) => ({
    status: 200,
    data:
      request.resource === 'pr'
        ? {
            repositoryId: s.github.repositoryId,
            prNodeId: s.github.prNodeId,
            owner: s.github.owner,
            name: s.github.name,
            number: s.github.pr,
            headSha,
            baseSha: 'b'.repeat(40),
            title: 'PR',
            state: 'open',
          }
        : {
            items:
              request.resource === 'ci'
                ? [
                    {
                      id: 'job',
                      headSha,
                      slot: 'build',
                      runId: '1',
                      runNumber: 1,
                      attempt: 1,
                      status: 'failed',
                      completedAt: '2026-11-21T12:00:00Z',
                    },
                  ]
                : [],
            hasNext: false,
          },
  }));
  const reserve = vi.fn(() => undefined);
  const make = (store: EventStore) => {
    const consent = new PrMonitorConsent({
      store: store.prMonitor,
      hasPersistentRevocationAuthority: () => true,
      isInteractive: () => true,
      isLoginCurrent: () => true,
      assertConversation: () => undefined,
      connection: () => ({
        connectionId: s.github.connectionId,
        connectionRevision: s.github.identityRevision,
        githubPrincipalId: 'github:123',
        repositoryId: s.github.repositoryId,
        prNodeId: s.github.prNodeId,
      }),
    });
    const observer = new PrMonitorObserver({
      store: store.prMonitor,
      capture: (c, id) => consent.capture(c, id),
      read,
      reserve,
      now: () => now,
      eligibleAuthors: ['owner'],
    });
    cleanup.push(() => observer.close());
    return observer;
  };
  const first = make(a),
    second = make(b);
  const observe = (observer = first) => observer.observe(s.operatorId, s.conversationId, s.id);
  const pendingRead = () => {
    let finish!: (response: Awaited<ReturnType<PrMonitorReadPort>>) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    return (status = 200) => finish({ status, data: {} });
  };
  return {
    a,
    b,
    sql,
    s,
    view,
    read,
    reserve,
    first,
    second,
    observe,
    pendingRead,
    advance: (ms = PR_MONITOR_CLAIM_TTL_MS) => {
      now += ms;
    },
    newHead: () => {
      headSha = 'c'.repeat(40);
    },
    now: () => now,
  };
}
it('coalesces competing controllers before charged reads and leaves the owner outbox intact', async () => {
  const f = fixture();
  await f.observe();
  f.newHead();
  await f.observe();
  const before = f.view();
  const finish = f.pendingRead();
  const operation = f.observe();
  const reads = f.read.mock.calls.length,
    charges = f.reserve.mock.calls.length;
  await f.observe(f.second);
  expect(f.read).toHaveBeenCalledTimes(reads);
  expect(f.reserve).toHaveBeenCalledTimes(charges);
  expect(f.view()).toEqual(before);
  finish();
  await operation;
});
it.each([200, 500])(
  'fences a late noncooperative response (%s) after another handle takes over',
  async (status) => {
    const f = fixture();
    await f.observe();
    const finish = f.pendingRead();
    const stale = f.observe();
    f.advance();
    f.newHead();
    await f.observe(f.second);
    const successor = f.view();
    expect(successor.outbox?.eventIds).toHaveLength(1);
    const reads = f.read.mock.calls.length;
    finish(status);
    await stale;
    expect(f.read).toHaveBeenCalledTimes(reads);
    expect(f.view()).toEqual(successor);
    await f.observe(f.second);
    expect(f.view().events).toHaveLength(successor.events.length);
    expect(f.view().counters.distinctEvents).toBe(successor.counters.distinctEvents);
  },
);
it.each(['stopped', 'deleted', 'renew', 'revoke'] as const)(
  'fences %s during an authenticated read through persisted consent',
  async (change) => {
    const f = fixture();
    const finish = f.pendingRead();
    const operation = f.observe();
    const s = f.view().subscription;
    if (change === 'renew') watch(f.b.prMonitor, s, f.now());
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
    finish();
    await operation;
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.view()).toEqual(retained);
  },
);
it('drain releases only its owned token while a successor read is still pending', async () => {
  const f = fixture();
  const oldResponse = f.pendingRead();
  const old = f.observe();
  f.advance();
  const newResponse = f.pendingRead();
  const next = f.observe(f.second);
  await f.first.close();
  await old;
  expect(f.a.prMonitor.leases.acquire(f.view().subscription, f.now())).toBeNull();
  oldResponse();
  newResponse();
  await next;
  const released = f.a.prMonitor.leases.acquire(f.view().subscription, f.now());
  expect(released).not.toBeNull();
});
it('acquisition storage failure performs no reads and cannot clear a retained outbox', async () => {
  const f = fixture();
  await f.observe();
  f.newHead();
  await f.observe();
  const retained = f.view();
  f.sql.exec(
    "CREATE TRIGGER reject_claim BEFORE UPDATE ON pr_monitor_leases BEGIN SELECT RAISE(ABORT, 'injected_claim_failure'); END",
  );
  const calls = f.read.mock.calls.length;
  await expect(f.observe(f.second)).rejects.toThrow('injected_claim_failure');
  expect(f.read).toHaveBeenCalledTimes(calls);
  expect(f.view()).toEqual(retained);
  expect(logs.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ stage: 'claim', code: 'SQLITE_CONSTRAINT_TRIGGER' }),
  );
});
it('retains sanitized publish failure stage and SQLite cause through the consumer', async () => {
  const f = fixture();
  await f.observe();
  const before = f.view();
  f.sql.exec(`CREATE TRIGGER reject_publish BEFORE UPDATE ON pr_monitor_subscriptions
    WHEN json_extract(NEW.data,'$.subscription.snapshotRevision') > json_extract(OLD.data,'$.subscription.snapshotRevision')
    BEGIN SELECT RAISE(ABORT, 'private injection details'); END`);
  await f.observe();
  expect(f.view().snapshot).toEqual(before.snapshot);
  expect(f.view().diagnostic).toMatchObject({ code: 'incomplete', stage: 'publish' });
  expect(logs.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ stage: 'publish', causeCode: 'SQLITE_CONSTRAINT_TRIGGER' }),
  );
  expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('private injection');
});
it('does not mislabel an HTTP failure as a storage failure', async () => {
  const f = fixture();
  f.read.mockResolvedValue({ status: 503, data: {} });
  await f.observe();
  expect(logs.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      stage: 'read',
      code: 'read_failed',
      causeCode: undefined,
    }),
  );
});
it('fences late authenticated HTTP through the runtime and retains every charged reservation', async () => {
  const f = fixture();
  vi.spyOn(Date, 'now').mockImplementation(f.now);
  const scope = f.a.prMonitor.authority(f.s.id, 'pr-watch')!.scope;
  const resetAt = f.now() + 3600000;
  let headSha = 'a'.repeat(40);
  const transport = vi.fn<Parameters<typeof createPrMonitorObservationRuntime>[0]['transport']>(
    async (endpoint) => ({
      status: 200,
      headers: {
        'x-ratelimit-resource': 'core',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(resetAt / 1000)),
      },
      data:
        endpoint === '/user'
          ? { id: 123 }
          : endpoint.includes('/reviews') || endpoint.includes('/comments')
            ? []
            : endpoint.includes('/actions')
              ? { total_count: 0, workflow_runs: [] }
              : {
                  node_id: f.s.github.prNodeId,
                  number: 1,
                  title: 'PR',
                  state: 'open',
                  merged: false,
                  head: { sha: headSha },
                  base: {
                    sha: 'b'.repeat(40),
                    repo: { node_id: 'repo', name: 'repo', owner: { login: 'owner' } },
                  },
                },
    }),
  );
  const make = (store: EventStore) => {
    const runtime = createPrMonitorObservationRuntime({
      eventStore: store,
      transport,
      eligibleAuthors: ['owner'],
      consent: {
        hasPersistentRevocationAuthority: () => true,
        isInteractive: () => true,
        isLoginCurrent: () => true,
        assertConversation: () => undefined,
        connection: () => scope,
      },
    });
    cleanup.push(() => runtime.close());
    return runtime;
  };
  const first = make(f.a),
    second = make(f.b);
  const observe = (runtime = first) =>
    runtime.observer.observe(f.s.operatorId, f.s.conversationId, f.s.id);
  await observe();
  expect(f.view().refreshState).toBe('current');
  let finish!: (value: Awaited<ReturnType<typeof transport>>) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = observe();
  const charged = f.a.githubReadQuota.inspect('github:123').charged;
  await observe(second);
  expect(f.a.githubReadQuota.inspect('github:123').charged).toBe(charged);
  f.advance();
  headSha = 'c'.repeat(40);
  await observe(second);
  const successor = f.view();
  expect(successor.snapshot?.headSha).toBe(headSha);
  const calls = transport.mock.calls.length;
  // Two complete collections (7 requests each: principal attestation only on the
  // opening and closing PR reads) plus the one held late request.
  expect(calls).toBe(15);
  finish({ status: 500, headers: {}, data: {} });
  await old;
  expect(transport).toHaveBeenCalledTimes(calls);
  expect(f.view()).toEqual(successor);
  expect(f.b.githubReadQuota.inspect('github:123').charged).toBe(calls);
  expect(f.sql.prepare('SELECT count(*) n FROM github_read_reservations').get()).toEqual({
    n: calls,
  });
});
