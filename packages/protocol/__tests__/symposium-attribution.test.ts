import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import Database from 'better-sqlite3';
import { SymposiumProvenanceSchema, type SymposiumConfig } from '../src/index.js';

const seat = (id: string, name: string, model: string) => ({
  id,
  name,
  role: id === 'architect' ? 'architect' : 'reviewer',
  model,
  systemPrompt: 'Work.',
  color: '#334455',
  reasoningEffort: 'high',
  accountBinding: {
    accountId: `account-${id}`,
    accountLabel: `Account ${name}`,
    provider: 'anthropic-vertex' as const,
    model,
    profileRevision: `account-rev-${id}`,
  },
  profileBinding: { profileId: `profile-${id}`, profileRevision: `profile-rev-${id}` },
  contextGrant: {
    grantId: `context-${id}`,
    revision: 1,
    classification: 'work' as const,
    sourceRefs: ['repo:mitzo'],
  },
  authorityGrant: {
    grantId: `authority-${id}`,
    revision: 1,
    filesystem: 'read' as const,
    tools: 'read' as const,
    network: 'restricted' as const,
  },
  isolationRequest: {
    trustDomainId: 'shared-work',
    revision: 1,
    placement: 'reuse-compatible' as const,
  },
});
const config: SymposiumConfig = {
  version: 2,
  revision: 1,
  state: 'active',
  activeSeatCap: 2,
  anchorSeatId: 'architect',
  seats: [seat('architect', 'Architect', 'model-a'), seat('reviewer', 'Reviewer', 'model-b')],
  turnRules: { mode: 'directed', maxTurns: 4 },
  interceptMode: 'manual',
};
const snapshot = (id: 'architect' | 'reviewer', at: number) => {
  const current = config.seats.find((candidate) => candidate.id === id)!;
  return {
    version: 2 as const,
    seatId: id,
    seatLabel: current.name,
    seatRole: current.role,
    configRevision: 1,
    membershipGeneration: 1,
    capturedAt: at,
    accountBinding: current.accountBinding!,
    reasoningEffort: current.reasoningEffort!,
    profileBinding: current.profileBinding!,
    contextGrant: { grantId: current.contextGrant!.grantId, revision: 1 },
    authorityGrant: { grantId: current.authorityGrant!.grantId, revision: 1 },
    isolationDomainId: 'shared-work',
    isolationDomainRevision: 1,
    accountProfileRevision: current.accountBinding!.profileRevision,
    seatProfileRevision: current.profileBinding!.profileRevision,
    contextGrantRevision: 1,
    authorityGrantRevision: 1,
  };
};
const dirs: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function open(path = ':memory:') {
  const store = new EventStore(path);
  stores.push(store);
  return store;
}
function admitBoth(store: EventStore) {
  store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
  store.setSymposiumConfig('chat', config);
  for (const id of ['architect', 'reviewer'] as const) {
    store.transitionSymposiumMembership({
      sessionId: 'chat',
      seatId: id,
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'director',
      reason: 'start',
      idempotencyKey: `admit:${id}`,
      occurredAt: 1,
    });
    store.markSymposiumMembershipReconciled('chat', id, 1, 'confirmed');
  }
}

describe('immutable Symposium attribution', () => {
  it('retains historical v1 fields without inventing unknown account or label data', () => {
    const legacy = {
      seatId: 'reviewer',
      configRevision: 1,
      accountProfileRevision: 'a',
      seatProfileRevision: 'p',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'shared-work',
      isolationDomainRevision: 1,
    };
    const parsed = SymposiumProvenanceSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed).not.toHaveProperty('accountBinding');
    expect(parsed).not.toHaveProperty('seatLabel');
  });
  it('round-trips interleaved seat snapshots across reopen/replay despite config edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symposium-attribution-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const store = open(path);
    admitBoth(store);
    const architect = snapshot('architect', 100);
    const reviewer = snapshot('reviewer', 101);
    const first = store.appendSymposium('chat', 'message_start', { messageId: 'a' }, architect);
    const second = store.appendSymposium('chat', 'message_start', { messageId: 'r' }, reviewer);
    const revised = {
      ...config,
      revision: 2,
      seats: config.seats.map((entry) =>
        entry.id === 'reviewer' ? { ...entry, name: 'Renamed reviewer', role: 'verifier' } : entry,
      ),
    };
    expect(() => store.setSymposiumConfig('chat', revised)).toThrow(/revoked/i);
    store.transitionSymposiumMembership({
      sessionId: 'chat',
      seatId: 'reviewer',
      action: 'suspend',
      expectedGeneration: 1,
      configRevision: 1,
      actor: 'director',
      reason: 'revise role',
      idempotencyKey: 'suspend:reviewer',
      occurredAt: 102,
    });
    store.setSymposiumConfig('chat', revised);
    expect(() =>
      store.appendSymposium('chat', 'block_delta', { messageId: 'r', delta: 'late' }, reviewer),
    ).toThrow(/membership/i);
    stores.pop()!.close();
    const reopened = open(path);
    expect(
      reopened
        .getSessionEventsThroughCursor('chat', second)
        .map((event) => event.symposiumProvenance),
    ).toEqual([architect, reviewer]);
    expect(reopened.getEventsAfter('chat', first)[0]).toMatchObject({
      seq: second,
      seatId: 'reviewer',
      symposiumProvenance: reviewer,
    });
  });
  it('rejects forged v2 labels, account/model/effort and grant references', () => {
    const store = open();
    admitBoth(store);
    const original = snapshot('reviewer', 100);
    for (const changed of [
      { ...original, seatLabel: 'Other' },
      { ...original, accountBinding: { ...original.accountBinding, model: 'other-model' } },
      { ...original, reasoningEffort: 'low' },
      { ...original, contextGrant: { grantId: 'other', revision: 1 } },
    ])
      expect(() => store.appendSymposium('chat', 'message_start', {}, changed)).toThrow(
        /provenance|snapshot/i,
      );
  });
  it('requires a complete v2 snapshot for new events in a v2 session', () => {
    const store = open();
    admitBoth(store);
    const {
      version,
      seatLabel,
      seatRole,
      capturedAt,
      accountBinding,
      reasoningEffort,
      profileBinding,
      contextGrant,
      authorityGrant,
      ...legacy
    } = snapshot('reviewer', 100);
    expect(() => store.appendSymposium('chat', 'message_start', {}, legacy)).toThrow(
      /v2 snapshot/i,
    );
  });
  it('adds snapshot columns to a database with historical recipient attempts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symposium-attribution-upgrade-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE symposium_recipient_attempts (
        attempt_id INTEGER PRIMARY KEY, delivery_id TEXT, seat_id TEXT,
        attempt_number INTEGER, idempotency_key TEXT, status TEXT,
        provider_thread_id TEXT, result_content TEXT, cost_usd REAL,
        error TEXT, started_at INTEGER, completed_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE symposium_late_results (
        delivery_id TEXT, seat_id TEXT, claim_token TEXT, provider_thread_id TEXT,
        result_content TEXT, cost_usd REAL, observed_at INTEGER
      );
    `);
    raw
      .prepare(
        `INSERT INTO symposium_recipient_attempts
      (attempt_id,delivery_id,seat_id,attempt_number,idempotency_key,status,
       cost_usd,started_at,updated_at)
      VALUES (1,'legacy','reviewer',1,'old-key','recovery_required',0,1,1)`,
      )
      .run();
    raw.close();
    const store = open(path);
    expect(store.getSymposiumRecipientAttempts('legacy')[0]).toMatchObject({
      claimToken: null,
      provenance: null,
    });
    const upgraded = new Database(path, { readonly: true });
    const columns = (table: string) =>
      upgraded.pragma(`table_info(${table})`) as Array<{ name: string }>;
    expect(columns('symposium_recipient_attempts').map((column) => column.name)).toEqual(
      expect.arrayContaining(['claim_token', 'symposium_provenance']),
    );
    expect(columns('symposium_late_results').map((column) => column.name)).toContain(
      'symposium_provenance',
    );
    upgraded.close();
  });
});
