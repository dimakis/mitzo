import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { AccountBindingSchema } from '@mitzo/protocol';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'custodian-loss-'));
  roots.push(root);
  const store = new EventStore(join(root, 'events.db'));
  const profiles = new AccountProfiles([
    {
      id: 'test',
      label: 'Test',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'unused', account: 'unused' },
      sandboxProvider: 'test',
      sandboxProviderId: 'test-object',
      models: [{ id: 'test', label: 'Test' }],
    },
  ]);
  const binding = AccountBindingSchema.parse(profiles.resolve('test', 'test'));
  const seat = {
    id: 'anchor',
    name: 'Anchor',
    role: 'coder',
    model: 'test',
    systemPrompt: 'test',
    color: '#223344',
    accountBinding: binding,
    profileBinding: { profileId: 'coder', profileRevision: 'p1' },
    contextGrant: {
      grantId: 'context',
      revision: 1,
      classification: 'work' as const,
      sourceRefs: [],
    },
    authorityGrant: {
      grantId: 'authority',
      revision: 1,
      filesystem: 'write' as const,
      tools: 'write' as const,
      network: 'restricted' as const,
    },
    isolationRequest: {
      trustDomainId: 'shared',
      revision: 1,
      placement: 'reuse-compatible' as const,
    },
  };
  store.upsertSession({ sessionId: 's', accountBinding: binding });
  store.setSymposiumConfig('s', {
    version: 2,
    revision: 1,
    state: 'active',
    anchorSeatId: 'anchor',
    activeSeatCap: 2,
    seats: [seat, { ...seat, id: 'second' }],
    turnRules: { mode: 'directed', maxTurns: 10 },
    interceptMode: 'manual',
  });
  for (const seatId of ['anchor', 'second']) {
    store.transitionSymposiumMembership({
      sessionId: 's',
      seatId,
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'operator',
      reason: 'initial',
      idempotencyKey: `admit-${seatId}`,
      occurredAt: 1,
    });
    store.markSymposiumMembershipReconciled('s', seatId, 1, 'confirmed');
  }
  return store;
}
it('fences every active membership including the anchor only through the retained controller-loss owner', () => {
  const store = fixture();
  try {
    expect(() =>
      store.transitionSymposiumMembership({
        sessionId: 's',
        seatId: 'anchor',
        action: 'suspend',
        expectedGeneration: 1,
        configRevision: 1,
        actor: 'operator',
        reason: 'ordinary',
        idempotencyKey: 'normal',
        occurredAt: 2,
      }),
    ).toThrow('anchor');
    const records = store.suspendSymposiumForControllerLoss(
      's',
      1,
      'retained-custodian-epoch-1',
      2,
    );
    expect(records.map((row) => [row.seatId, row.state, row.reconciliation])).toEqual([
      ['anchor', 'suspended', 'pending'],
      ['second', 'suspended', 'pending'],
    ]);
    expect(store.getLatestSymposiumMembership('s', 'anchor')?.generation).toBe(2);
    expect(
      store.suspendSymposiumForControllerLoss('s', 1, 'retained-custodian-epoch-1', 2),
    ).toEqual([]);
  } finally {
    store.close();
  }
});
it('does not partially revoke a session when the expected revision is stale', () => {
  const store = fixture();
  try {
    expect(() => store.suspendSymposiumForControllerLoss('s', 2, 'epoch', 2)).toThrow('revision');
    for (const id of ['anchor', 'second'])
      expect(store.getLatestSymposiumMembership('s', id)?.state).toBe('active');
  } finally {
    store.close();
  }
});

it('rolls back every suspension when one seat has pending exact creation recovery', () => {
  const store = fixture();
  const db = new Database(join(roots.at(-1)!, 'events.db'));
  try {
    const original = JSON.stringify({
      idempotencyKey: 'retained-recovery',
      physicalId: 'exact-original',
    });
    db.prepare('INSERT INTO symposium_creation_recoveries VALUES (?,?,?,?,NULL)').run(
      's',
      'second',
      1,
      original,
    );
    expect(() => store.suspendSymposiumForControllerLoss('s', 1, 'epoch', 2)).toThrow(
      'cleanup is pending',
    );
    for (const id of ['anchor', 'second'])
      expect(store.getLatestSymposiumMembership('s', id)?.generation).toBe(1);
    expect(
      db.prepare('SELECT request_json,result_json FROM symposium_creation_recoveries').get(),
    ).toEqual({ request_json: original, result_json: null });
  } finally {
    db.close();
    store.close();
  }
});
it('uses existing runtime drain after durable suspension and leaves uncertainty pending', async () => {
  const { drainRetainedSymposiumControllers } = await import('../symposium-controller-drain.js');
  const store = fixture();
  let fenced = false;
  try {
    const runtimes = new Map([
      [
        's',
        {
          runtime: {
            beginShutdown() {
              fenced = true;
            },
            async drain() {
              expect(fenced).toBe(true);
              expect(store.getLatestSymposiumMembership('s', 'anchor')?.state).toBe('suspended');
              throw Error('exact stop missing');
            },
          },
        },
      ],
    ]);
    await expect(
      drainRetainedSymposiumControllers(store, runtimes, 'epoch', new AbortController().signal),
    ).rejects.toThrow('cleanup');
    expect(store.getLatestSymposiumMembership('s', 'anchor')?.reconciliation).toBe('pending');
    expect(runtimes.size).toBe(1);
  } finally {
    store.close();
  }
});
it('retires only successfully drained runtime owners and requires explicit later restore', async () => {
  const { drainRetainedSymposiumControllers } = await import('../symposium-controller-drain.js');
  const store = fixture();
  try {
    const runtimes = new Map([['s', { runtime: { beginShutdown() {}, async drain() {} } }]]);
    await drainRetainedSymposiumControllers(store, runtimes, 'epoch', new AbortController().signal);
    expect(runtimes.size).toBe(0);
    expect(store.getLatestSymposiumMembership('s', 'anchor')).toMatchObject({
      state: 'suspended',
      reconciliation: 'confirmed',
      generation: 2,
    });
  } finally {
    store.close();
  }
});
