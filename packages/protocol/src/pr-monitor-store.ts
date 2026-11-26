import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  PrMonitorSubscriptionSchema,
  PrMonitorSnapshotSchema,
  PrMonitorFindingSchema,
  PrMonitorAuthoritySchema,
  type PrMonitorAuthority,
  type PrMonitorSubscription,
  type PrMonitorObservation,
  type PrMonitorSnapshot,
  type PrMonitorFinding,
  type PrMonitorDiagnostic,
  type PrMonitorEvent,
  type PrMonitorProjection,
} from './pr-monitor.js';

export const prMonitorDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const row = (value: unknown) => value as { data: string } | undefined;
function boundedEvents(events: PrMonitorEvent[]): PrMonitorEvent[] {
  const selected: PrMonitorEvent[] = [];
  let references = 0;
  for (const event of events) {
    if (
      selected.length >= 20 ||
      references + event.references.length > 20 ||
      Buffer.byteLength(JSON.stringify([...selected, event])) > 16384
    )
      continue;
    selected.push(event);
    references += event.references.length;
  }
  return selected;
}
/** Borrows EventStore's existing SQLite owner/transaction lifetime. No second DB,
 * provider client, timer or execution ledger. Callers own authorization fences. */
export class PrMonitorStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS pr_monitor_subscriptions (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, conversation_id TEXT NOT NULL, repository_id TEXT NOT NULL, pr_node_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(operator_id,conversation_id,repository_id,pr_node_id));
      CREATE TABLE IF NOT EXISTS pr_monitor_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_monitor_authorities (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(subscription_id,kind));
      CREATE INDEX IF NOT EXISTS pr_monitor_conversation ON pr_monitor_subscriptions(operator_id,conversation_id);`);
  }
  create(requestId: string, input: PrMonitorSubscription): PrMonitorObservation {
    const subscription = PrMonitorSubscriptionSchema.parse(input);
    if (!requestId || requestId.length > 200) throw Error('invalid_request');
    const fingerprint = prMonitorDigest(subscription);
    return this.db.transaction(() => {
      const prior = this.db
        .prepare('SELECT fingerprint,result FROM pr_monitor_requests WHERE id=?')
        .get(requestId) as { fingerprint: string; result: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Error('request_conflict');
        return JSON.parse(prior.result) as PrMonitorObservation;
      }
      if (
        subscription.revision !== 1 ||
        subscription.snapshotRevision !== 0 ||
        subscription.eligibilityRevision !== 0 ||
        subscription.head ||
        subscription.watch ||
        subscription.autoFix ||
        subscription.merge ||
        subscription.lifecycle !== 'paused'
      )
        throw Error('invalid_initial_subscription');
      if (
        this.db
          .prepare(
            'SELECT 1 FROM pr_monitor_subscriptions WHERE id=? OR (operator_id=? AND conversation_id=? AND repository_id=? AND pr_node_id=?)',
          )
          .get(
            subscription.id,
            subscription.operatorId,
            subscription.conversationId,
            subscription.github.repositoryId,
            subscription.github.prNodeId,
          )
      )
        throw Error('subscription_exists');
      const count = this.db
        .prepare(
          'SELECT count(*) total, sum(conversation_id=?) conversation FROM pr_monitor_subscriptions WHERE operator_id=?',
        )
        .get(subscription.conversationId, subscription.operatorId) as {
        total: number;
        conversation: number;
      };
      if (count.total >= 100 || count.conversation >= 20) throw Error('subscription_limit');
      const result: PrMonitorObservation = {
        baselinePending: true,
        failureCount: 0,
        subscription: { ...subscription, eligibilityDigest: prMonitorDigest([]) },
        snapshot: null,
        events: [],
        outbox: null,
        refreshState: 'stale',
        diagnostic: null,
        counters: { observations: 0, distinctEvents: 0, modelTurns: 0 },
      };
      this.db
        .prepare('INSERT INTO pr_monitor_subscriptions VALUES (?,?,?,?,?,?)')
        .run(
          subscription.id,
          subscription.operatorId,
          subscription.conversationId,
          subscription.github.repositoryId,
          subscription.github.prNodeId,
          JSON.stringify(result),
        );
      this.db
        .prepare('INSERT INTO pr_monitor_requests VALUES (?,?,?)')
        .run(requestId, fingerprint, JSON.stringify(result));
      return result;
    })();
  }
  read(operatorId: string, conversationId: string, id: string): PrMonitorObservation {
    const saved = row(
      this.db
        .prepare(
          'SELECT data FROM pr_monitor_subscriptions WHERE id=? AND operator_id=? AND conversation_id=?',
        )
        .get(id, operatorId, conversationId),
    );
    if (!saved) throw Error('subscription_unavailable');
    const view = JSON.parse(saved.data) as PrMonitorObservation;
    PrMonitorSubscriptionSchema.parse(view.subscription);
    return view;
  }
  list(operatorId: string, conversationId: string): PrMonitorObservation[] {
    return (
      this.db
        .prepare(
          'SELECT id FROM pr_monitor_subscriptions WHERE operator_id=? AND conversation_id=? ORDER BY id LIMIT 20',
        )
        .all(operatorId, conversationId) as { id: string }[]
    ).map((r) => this.read(operatorId, conversationId, r.id));
  }
  projection(operatorId: string, conversationId: string, id: string): PrMonitorProjection {
    const view = this.read(operatorId, conversationId, id);
    const byId = new Map(view.events.map((event) => [event.id, event]));
    const events = boundedEvents(
      view.outbox ? view.outbox.eventIds.map((id) => byId.get(id)!) : [...view.events].reverse(),
    );
    return { ...view, version: 1, events, hiddenEvents: view.events.length - events.length };
  }
  /** Bounded oldest-attempt rotation; caller invokes from the existing scheduler. */
  due(now: number): PrMonitorSubscription[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM pr_monitor_subscriptions WHERE json_extract(data,'$.subscription.lifecycle')='watching' AND json_extract(data,'$.subscription.nextRefreshAt')<=? ORDER BY COALESCE(json_extract(data,'$.subscription.lastAttemptAt'),0),id LIMIT 2",
        )
        .all(now) as { data: string }[]
    ).map((r) =>
      PrMonitorSubscriptionSchema.parse((JSON.parse(r.data) as PrMonitorObservation).subscription),
    );
  }
  stopConversation(conversationId: string, reason: 'deleted' | 'stopped') {
    this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT operator_id,id FROM pr_monitor_subscriptions WHERE conversation_id=?')
        .all(conversationId) as { operator_id: string; id: string }[];
      for (const r of rows) {
        const view = this.read(r.operator_id, conversationId, r.id);
        view.subscription.revision++;
        view.subscription.lifecycle = reason === 'deleted' ? 'removed' : 'paused';
        view.subscription.nextRefreshAt = null;
        view.subscription.eligibilityRevision++;
        view.subscription.eligibilityDigest = prMonitorDigest([]);
        view.baselinePending = true;
        view.outbox = null;
        view.refreshState = 'blocked';
        for (const event of view.events)
          if (event.disposition === 'actionable') event.disposition = 'superseded';
        this.save(view);
      }
    })();
  }
  private save(view: PrMonitorObservation) {
    this.db
      .prepare('UPDATE pr_monitor_subscriptions SET data=? WHERE id=?')
      .run(JSON.stringify(view), view.subscription.id);
  }
  authority(subscriptionId: string, kind: PrMonitorAuthority['kind']): PrMonitorAuthority | null {
    const saved = row(
      this.db
        .prepare('SELECT data FROM pr_monitor_authorities WHERE subscription_id=? AND kind=?')
        .get(subscriptionId, kind),
    );
    return saved ? PrMonitorAuthoritySchema.parse(JSON.parse(saved.data)) : null;
  }
  /** Internal Access persistence, never an HTTP/tool authority entrypoint. */
  mutateAuthority(input: {
    requestId: string;
    fingerprint: string;
    operatorId: string;
    conversationId: string;
    subscriptionId: string;
    expectedRevision: number;
    expectedAuthorityRevision: number;
    kind: PrMonitorAuthority['kind'];
    change(previous: PrMonitorAuthority | null): PrMonitorAuthority;
    assertCurrent(): void;
  }): PrMonitorAuthority {
    if (!input.requestId || input.requestId.length > 200) throw Error('invalid_request');
    return this.db.transaction(() => {
      input.assertCurrent();
      const prior = this.db
        .prepare('SELECT fingerprint,result FROM pr_monitor_requests WHERE id=?')
        .get(input.requestId) as { fingerprint: string; result: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) throw Error('request_conflict');
        return PrMonitorAuthoritySchema.parse(JSON.parse(prior.result));
      }
      const view = this.read(input.operatorId, input.conversationId, input.subscriptionId);
      const previous = this.authority(input.subscriptionId, input.kind);
      if (
        view.subscription.revision !== input.expectedRevision ||
        (previous?.revision ?? 0) !== input.expectedAuthorityRevision
      )
        throw Error('revision_conflict');
      const authority = PrMonitorAuthoritySchema.parse(input.change(previous));
      if (
        authority.subscriptionId !== input.subscriptionId ||
        authority.conversationId !== input.conversationId ||
        authority.kind !== input.kind ||
        authority.revision !== input.expectedAuthorityRevision + 1 ||
        (previous && authority.id !== previous.id)
      )
        throw Error('authority_identity_conflict');
      this.db
        .prepare(
          'INSERT INTO pr_monitor_authorities VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(authority.id, authority.subscriptionId, authority.kind, JSON.stringify(authority));
      const ref = {
        id: authority.id,
        revision: authority.revision,
        expiresAt: authority.expiresAt,
      };
      // Removed and merged subscriptions are terminal. Revocation is still
      // recorded, but nothing (including revoke followed by issue) can resume them.
      const terminal =
        view.subscription.lifecycle === 'removed' || view.subscription.lifecycle === 'merged';
      if (authority.kind === 'pr-watch' && terminal && authority.revokedAt === null)
        throw Error('subscription_unavailable');
      if (authority.kind === 'pr-watch') {
        view.subscription.watch = ref;
        if (!terminal)
          view.subscription.lifecycle = authority.revokedAt === null ? 'watching' : 'paused';
        view.subscription.nextRefreshAt = authority.revokedAt === null ? 0 : null;
        view.refreshState = authority.revokedAt === null ? 'stale' : 'blocked';
        // A new Watch is a new baseline. Delivery sees revision invalidation;
        // its native cancellation/uncertainty remains solely delivery-owned.
        view.outbox = null;
        view.baselinePending = true;
        for (const event of view.events)
          if (event.disposition === 'actionable') event.disposition = 'superseded';
        view.subscription.eligibilityRevision++;
        view.subscription.eligibilityDigest = prMonitorDigest([]);
      } else view.subscription.autoFix = ref;
      view.subscription.revision++;
      input.assertCurrent();
      this.save(view);
      this.db
        .prepare('INSERT INTO pr_monitor_requests VALUES (?,?,?)')
        .run(input.requestId, input.fingerprint, JSON.stringify(authority));
      return authority;
    })();
  }
  publish(input: {
    operatorId: string;
    conversationId: string;
    subscriptionId: string;
    expectedRevision: number;
    expectedSnapshotRevision: number;
    snapshot: PrMonitorSnapshot;
    findings: PrMonitorFinding[];
    baseline: boolean;
    assertCurrent(): void;
  }): PrMonitorObservation {
    const snapshot = PrMonitorSnapshotSchema.parse(input.snapshot);
    if (!snapshot.complete || input.findings.length > 1000) throw Error('incomplete_observation');
    const findings = input.findings.map((f) => PrMonitorFindingSchema.parse(f));
    return this.db.transaction(() => {
      input.assertCurrent();
      const view = this.read(input.operatorId, input.conversationId, input.subscriptionId);
      const s = view.subscription;
      if (
        s.revision !== input.expectedRevision ||
        s.snapshotRevision !== input.expectedSnapshotRevision
      )
        throw Error('revision_conflict');
      if (s.lifecycle === 'removed') throw Error('subscription_unavailable');
      const changed = s.head?.sha !== snapshot.headSha;
      const generation = (s.head?.generation ?? 0) + (changed ? 1 : 0);
      s.head = { sha: snapshot.headSha, baseSha: snapshot.baseSha, generation };
      const selected = new Set<string>();
      for (const finding of snapshot.state === 'open' ? findings : []) {
        const sourceIds = [...new Set(finding.sourceIds)].sort();
        const eventId = prMonitorDigest([
          1,
          s.id,
          generation,
          snapshot.headSha,
          finding.kind,
          sourceIds,
        ]);
        selected.add(eventId);
        const prior = view.events.find((e) => e.id === eventId);
        const evidenceDigest = prMonitorDigest({ ...finding, sourceIds });
        if (prior) {
          if (prior.evidenceDigest !== evidenceDigest) throw Error('event_conflict');
          if (input.baseline) prior.disposition = 'status_only';
          else if (prior.disposition === 'recovered') prior.disposition = 'actionable';
        } else
          view.events.push({
            ...finding,
            sourceIds,
            version: 1,
            id: eventId,
            evidenceDigest,
            subscriptionId: s.id,
            headSha: snapshot.headSha,
            generation,
            observedAt: snapshot.observedAt,
            disposition: input.baseline ? 'status_only' : 'actionable',
          });
      }
      for (const event of view.events) {
        if (event.generation !== generation) event.disposition = 'superseded';
        else if (
          !selected.has(event.id) &&
          ['actionable', 'status_only'].includes(event.disposition)
        )
          event.disposition = 'recovered';
      }
      const eligible = view.events
        .filter((e) => e.disposition === 'actionable')
        .map((e) => e.id)
        .sort();
      const eligibilityDigest = prMonitorDigest(eligible);
      if (eligibilityDigest !== s.eligibilityDigest) s.eligibilityRevision++;
      s.eligibilityDigest = eligibilityDigest;
      const now = snapshot.observedAt;
      const old = view.outbox;
      const byId = new Map(view.events.map((event) => [event.id, event]));
      const bounded = boundedEvents(eligible.map((id) => byId.get(id)!));
      const firstObservedAt = old?.headSha === snapshot.headSha ? old.firstObservedAt : now;
      view.outbox = bounded.length
        ? {
            eventIds: bounded.map((e) => e.id),
            eligibilityRevision: s.eligibilityRevision,
            eligibilityDigest,
            headSha: snapshot.headSha,
            generation,
            availableAt:
              old?.eligibilityDigest === eligibilityDigest
                ? old.availableAt
                : Math.min(now + 15000, firstObservedAt + 60000),
            firstObservedAt,
            overflow: eligible.length - bounded.length,
          }
        : null;
      s.snapshotRevision++;
      s.lastAttemptAt = now;
      s.lastSuccessfulRefreshAt = now;
      s.nextRefreshAt = snapshot.state === 'open' ? now + 60000 : null;
      if (snapshot.state !== 'open') s.lifecycle = snapshot.state;
      view.snapshot = snapshot;
      view.refreshState = 'current';
      view.diagnostic = null;
      view.baselinePending = false;
      view.failureCount = 0;
      view.counters.observations++;
      view.counters.distinctEvents = view.events.length;
      input.assertCurrent();
      this.save(view);
      return view;
    })();
  }
  fail(
    operatorId: string,
    conversationId: string,
    id: string,
    expectedRevision: number,
    diagnostic: PrMonitorDiagnostic,
    now: number,
  ) {
    return this.db.transaction(() => {
      const view = this.read(operatorId, conversationId, id);
      if (view.subscription.revision !== expectedRevision) throw Error('revision_conflict');
      view.diagnostic = diagnostic;
      // Last-success evidence remains visible, but uncertain current state must
      // invalidate every previously captured delivery eligibility fence.
      const emptyDigest = prMonitorDigest([]);
      if (view.subscription.eligibilityDigest !== emptyDigest)
        view.subscription.eligibilityRevision++;
      view.subscription.eligibilityDigest = emptyDigest;
      view.outbox = null;
      view.refreshState =
        diagnostic.code === 'rate_limited'
          ? 'backoff'
          : diagnostic.code === 'quota_delayed'
            ? 'quota_delayed'
            : diagnostic.code.endsWith('unavailable')
              ? 'blocked'
              : 'partial';
      view.subscription.lastAttemptAt = now;
      view.failureCount++;
      view.subscription.nextRefreshAt =
        diagnostic.nextRefreshAt === null
          ? null
          : Math.max(
              diagnostic.nextRefreshAt,
              now + Math.min(1800000, 60000 * 2 ** Math.min(5, view.failureCount - 1)),
            );
      view.diagnostic.nextRefreshAt = view.subscription.nextRefreshAt;
      if (diagnostic.code.endsWith('unavailable')) view.subscription.lifecycle = 'unavailable';
      this.save(view);
      return view;
    })();
  }
}
