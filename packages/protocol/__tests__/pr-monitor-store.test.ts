import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import { PrMonitorSubscriptionSchema } from '../src/pr-monitor.js';

const id = '9c6bb0d4-081f-4f55-86f8-60c703452053';
const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const input = () => ({
  version: 1 as const,
  id,
  revision: 1,
  operatorId: 'ordinary:user',
  conversationId: 'chat',
  github: {
    connectionId: id,
    identityRevision: '1',
    repositoryId: 'repo-node',
    owner: 'owner',
    name: 'repo',
    pr: 7,
    prNodeId: 'pr-node',
  },
  execution: {
    binding: {
      version: 2 as const,
      account: { accountId: 'personal', provider: 'openai-codex' as const, profileRevision: '1' },
      harness: { implementation: 'codex' as const },
      execution: { location: 'local' as const, targetId: 'mac', targetRevision: '1' },
    },
    selectionRevision: '1',
    profileRevision: '1',
    workspaceId: 'workspace',
  },
  head: null,
  watch: null,
  autoFix: null,
  merge: null,
  lifecycle: 'paused' as const,
  lastAttemptAt: null,
  lastSuccessfulRefreshAt: null,
  nextRefreshAt: null,
  snapshotRevision: 0,
  eligibilityRevision: 0,
  eligibilityDigest: digest,
});
const snapshot = {
  title: 'Example',
  state: 'open' as const,
  headSha: sha,
  baseSha: 'c'.repeat(40),
  complete: true,
  observedAt: 1000,
  ci: 'failed' as const,
  review: 'none' as const,
};
const failure = {
  kind: 'ci_failure' as const,
  sourceIds: ['run:1:attempt:1:job:2:failed'],
  summary: 'CI failed',
  references: [
    { kind: 'job' as const, id: '2', url: 'https://github.com/owner/repo/actions/runs/1/job/2' },
  ],
  truncated: false,
};
const stores: EventStore[] = [];
const directories: string[] = [];
const open = (path = ':memory:') => {
  const s = new EventStore(path);
  s.upsertSession({ sessionId: 'chat' });
  stores.push(s);
  return s;
};
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('PR monitor event-store owner', () => {
  it('compacts superseded generations while retaining current-head deduplication and lifetime event counters', () => {
    const s = open();
    s.prMonitor.create('request', input());
    const publish = (headSha: string, source: string) =>
      s.prMonitor.publish({
        operatorId: 'ordinary:user',
        conversationId: 'chat',
        subscriptionId: id,
        expectedRevision: 1,
        expectedSnapshotRevision: s.prMonitor.read('ordinary:user', 'chat', id).subscription
          .snapshotRevision,
        snapshot: { ...snapshot, headSha },
        findings: [{ ...failure, sourceIds: [source] }],
        baseline: false,
        assertCurrent: () => undefined,
      });
    for (let i = 0; i < 120; i++) publish(i.toString(16).padStart(40, '0'), `job-${i}`);
    const last = s.prMonitor.read('ordinary:user', 'chat', id);
    expect(last.events).toHaveLength(101);
    expect(last.counters.distinctEvents).toBe(120);
    expect(last.compactedEvents).toBe(19);
    const same = publish((119).toString(16).padStart(40, '0'), 'job-119');
    expect(same.outbox?.eventIds).toEqual(last.outbox?.eventIds);
    expect(same.counters.distinctEvents).toBe(120);
    // Returning to an old SHA is a new generation, never a replay of pruned eligibility.
    const returned = publish('0'.repeat(40), 'job-0');
    expect(returned.counters.distinctEvents).toBe(121);
    expect(returned.outbox?.generation).toBe(121);
  });
  it('refuses current-head history overflow transactionally without forgetting event identities', () => {
    const s = open();
    s.prMonitor.create('request', input());
    const publish = (findings: (typeof failure)[]) =>
      s.prMonitor.publish({
        operatorId: 'ordinary:user',
        conversationId: 'chat',
        subscriptionId: id,
        expectedRevision: 1,
        expectedSnapshotRevision: s.prMonitor.read('ordinary:user', 'chat', id).subscription
          .snapshotRevision,
        snapshot,
        findings,
        baseline: false,
        assertCurrent: () => undefined,
      });
    const retained = publish(
      Array.from({ length: 1000 }, (_, i) => ({ ...failure, sourceIds: [`job-${i}`] })),
    );
    expect(() => publish([{ ...failure, sourceIds: ['overflow'] }])).toThrow('retention_limit');
    expect(s.prMonitor.read('ordinary:user', 'chat', id)).toEqual(retained);
  });
  it('withdraws delivery eligibility on incomplete evidence and baselines recovered evidence on renewal', () => {
    const s = open();
    s.prMonitor.create('request', input());
    const publish = (baseline: boolean, findings = [failure]) =>
      s.prMonitor.publish({
        operatorId: 'ordinary:user',
        conversationId: 'chat',
        subscriptionId: id,
        expectedRevision: 1,
        expectedSnapshotRevision: s.prMonitor.read('ordinary:user', 'chat', id).subscription
          .snapshotRevision,
        snapshot,
        findings,
        baseline,
        assertCurrent: () => undefined,
      });
    const first = publish(false);
    s.prMonitor.fail(
      'ordinary:user',
      'chat',
      id,
      1,
      { code: 'head_changed', stage: 'read', nextRefreshAt: 60000 },
      2000,
    );
    const incomplete = s.prMonitor.read('ordinary:user', 'chat', id);
    expect(incomplete.outbox).toBeNull();
    expect(incomplete.subscription.eligibilityRevision).toBeGreaterThan(
      first.subscription.eligibilityRevision,
    );
    expect(incomplete.snapshot).toEqual(first.snapshot);
    expect(publish(false).outbox).not.toBeNull();
    publish(false, []);
    expect(publish(true).outbox).toBeNull();
    expect(publish(false).outbox).toBeNull();
  });
  it('bounds combined evidence by references and bytes, and pauses stopped conversations durably', () => {
    const s = open();
    s.prMonitor.create('request', input());
    const findings = Array.from({ length: 25 }, (_, i) => ({
      ...failure,
      sourceIds: [`job-${i}`],
      summary: '😀'.repeat(1000),
      references: [
        {
          kind: 'job' as const,
          id: String(i),
          url: `https://github.com/owner/repo/actions/runs/1/job/${i}`,
        },
      ],
    }));
    const view = s.prMonitor.publish({
      operatorId: 'ordinary:user',
      conversationId: 'chat',
      subscriptionId: id,
      expectedRevision: 1,
      expectedSnapshotRevision: 0,
      snapshot,
      findings,
      baseline: false,
      assertCurrent: () => undefined,
    });
    const batch = view.events.filter((e) => view.outbox?.eventIds.includes(e.id));
    expect(batch.reduce((n, e) => n + e.references.length, 0)).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(16384);
    expect(view.outbox?.overflow).toBeGreaterThan(0);
    const projection = s.prMonitor.projection('ordinary:user', 'chat', id);
    expect(projection.version).toBe(1);
    expect(projection.events.map((e) => e.id)).toEqual(view.outbox?.eventIds);
    expect(projection.hiddenEvents).toBe(25 - projection.events.length);
    expect(Buffer.byteLength(JSON.stringify(projection.events))).toBeLessThanOrEqual(16384);
    s.prMonitor.stopConversation('chat', 'stopped');
    const stopped = s.prMonitor.read('ordinary:user', 'chat', id);
    expect(stopped.subscription.lifecycle).toBe('paused');
    expect(stopped.outbox).toBeNull();
    expect(stopped.baselinePending).toBe(true);
    expect(s.prMonitor.due(100000)).toEqual([]);
  });
  it('rejects executable fields and invalid binding instead of stripping them', () => {
    expect(() => PrMonitorSubscriptionSchema.parse({ ...input(), command: 'run this' })).toThrow();
    expect(() =>
      PrMonitorSubscriptionSchema.parse({ ...input(), github: { ...input().github, pr: 0 } }),
    ).toThrow();
  });
  it('deduplicates exact requests and canonical PR identity, and isolates operators and chats', () => {
    const s = open();
    const first = s.prMonitor.create('request', input());
    expect(s.prMonitor.create('request', input())).toEqual(first);
    expect(() => s.prMonitor.create('request', { ...input(), conversationId: 'other' })).toThrow(
      'request_conflict',
    );
    expect(() =>
      s.prMonitor.create('second', { ...input(), id: '88670c57-e526-45c8-9d9c-29ef5ea4a522' }),
    ).toThrow('subscription_exists');
    expect(s.prMonitor.list('other', 'chat')).toEqual([]);
    expect(s.prMonitor.list('ordinary:user', 'other')).toEqual([]);
    expect(() => s.prMonitor.read('other', 'chat', id)).toThrow('subscription_unavailable');
  });
  it('retains baseline, snapshot, deduplication and combined eligibility across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-monitor-'));
    directories.push(dir);
    const path = join(dir, 'events.sqlite');
    let s = open(path);
    s.prMonitor.create('request', input());
    const publish = (baseline: boolean, findings = [failure]) =>
      s.prMonitor.publish({
        operatorId: 'ordinary:user',
        conversationId: 'chat',
        subscriptionId: id,
        expectedRevision: 1,
        expectedSnapshotRevision: s.prMonitor.read('ordinary:user', 'chat', id).subscription
          .snapshotRevision,
        snapshot,
        findings,
        baseline,
        assertCurrent: () => undefined,
      });
    expect(publish(true).events[0].disposition).toBe('status_only');
    expect(publish(false).outbox).toBeNull();
    const newer = { ...failure, sourceIds: ['run:1:attempt:2:job:3:failed'] };
    const published = publish(false, [newer]);
    expect(published.outbox?.eventIds).toHaveLength(1);
    expect(published.subscription.eligibilityRevision).toBe(1);
    s.close();
    stores.splice(stores.indexOf(s), 1);
    s = open(path);
    expect(s.prMonitor.read('ordinary:user', 'chat', id)).toEqual(published);
    expect(publish(false, [newer]).events).toHaveLength(2);
    expect(s.prMonitor.read('ordinary:user', 'chat', id).counters.modelTurns).toBe(0);
  });
  it('rolls snapshot and events back together when the final authority fence fails', () => {
    const s = open();
    s.prMonitor.create('request', input());
    let calls = 0;
    expect(() =>
      s.prMonitor.publish({
        operatorId: 'ordinary:user',
        conversationId: 'chat',
        subscriptionId: id,
        expectedRevision: 1,
        expectedSnapshotRevision: 0,
        snapshot,
        findings: [failure],
        baseline: false,
        assertCurrent: () => {
          if (++calls === 2) throw Error('revoked');
        },
      }),
    ).toThrow('revoked');
    const view = s.prMonitor.read('ordinary:user', 'chat', id);
    expect(view.snapshot).toBeNull();
    expect(view.events).toEqual([]);
    expect(view.outbox).toBeNull();
  });
  it('fences stale collectors and supersedes old heads while retaining event identity', () => {
    const s = open();
    s.prMonitor.create('request', input());
    const args = {
      operatorId: 'ordinary:user',
      conversationId: 'chat',
      subscriptionId: id,
      expectedRevision: 1,
      expectedSnapshotRevision: 0,
      snapshot,
      findings: [failure],
      baseline: false,
      assertCurrent: () => undefined,
    };
    const first = s.prMonitor.publish(args);
    expect(() => s.prMonitor.publish(args)).toThrow('revision_conflict');
    const next = s.prMonitor.publish({
      ...args,
      expectedSnapshotRevision: 1,
      snapshot: { ...snapshot, headSha: 'd'.repeat(40) },
    });
    expect(next.subscription.head?.generation).toBe(2);
    expect(next.events.find((e) => e.id === first.events[0].id)?.disposition).toBe('superseded');
    expect(next.outbox?.eventIds).not.toContain(first.events[0].id);
  });
  it('recovery clears the current combined outbox, retaining last success through sanitized errors', () => {
    const s = open();
    s.prMonitor.create('request', input());
    const args = {
      operatorId: 'ordinary:user',
      conversationId: 'chat',
      subscriptionId: id,
      expectedRevision: 1,
      expectedSnapshotRevision: 0,
      snapshot,
      findings: [failure],
      baseline: false,
      assertCurrent: () => undefined,
    };
    s.prMonitor.publish(args);
    const recovered = s.prMonitor.publish({
      ...args,
      expectedSnapshotRevision: 1,
      snapshot: { ...snapshot, ci: 'passed' },
      findings: [],
    });
    expect(recovered.outbox).toBeNull();
    expect(recovered.events[0].disposition).toBe('recovered');
    expect(recovered.subscription.eligibilityRevision).toBe(2);
    s.prMonitor.fail(
      'ordinary:user',
      'chat',
      id,
      1,
      { code: 'rate_limited', stage: 'read', nextRefreshAt: 5000 },
      2000,
    );
    const delayed = s.prMonitor.read('ordinary:user', 'chat', id);
    expect(delayed.snapshot).toEqual(recovered.snapshot);
    expect(delayed.refreshState).toBe('backoff');
    expect(delayed.subscription.lastSuccessfulRefreshAt).toBe(1000);
  });
});
