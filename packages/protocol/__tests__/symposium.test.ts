import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import {
  AccountBindingSchema,
  SymposiumConfigSchema,
  SymposiumProvenanceSchema,
  type SymposiumConfig,
} from '../src/index.js';

const config: SymposiumConfig = {
  version: 1,
  revision: 1,
  state: 'active',
  seats: [
    {
      id: 'builder',
      name: 'Builder',
      role: 'primary',
      model: 'model-a',
      systemPrompt: 'Build.',
      color: '#8040cc',
      accountBinding: {
        accountId: 'work-builder',
        accountLabel: 'Work Builder',
        provider: 'openai-codex',
        model: 'model-a',
        profileRevision: 'account-1',
      },
      profileBinding: { profileId: 'builder', profileRevision: 'profile-1' },
      contextGrant: {
        grantId: 'context-builder',
        revision: 1,
        classification: 'work',
        sourceRefs: ['repo:mitzo'],
      },
      authorityGrant: {
        grantId: 'authority-builder',
        revision: 1,
        filesystem: 'write',
        tools: 'write',
        network: 'restricted',
      },
      isolationRequest: { trustDomainId: 'work', revision: 1, placement: 'reuse-compatible' },
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      model: 'model-b',
      systemPrompt: 'Review.',
      color: '#008888',
      accountBinding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'anthropic-vertex',
        model: 'model-b',
        profileRevision: 'account-2',
      },
      profileBinding: { profileId: 'reviewer', profileRevision: 'profile-2' },
      contextGrant: {
        grantId: 'context-reviewer',
        revision: 1,
        classification: 'work',
        sourceRefs: ['repo:mitzo'],
      },
      authorityGrant: {
        grantId: 'authority-reviewer',
        revision: 1,
        filesystem: 'read',
        tools: 'read',
        network: 'restricted',
      },
      isolationRequest: { trustDomainId: 'work', revision: 1, placement: 'reuse-compatible' },
    },
  ],
  turnRules: { mode: 'directed', maxTurns: 6 },
  interceptMode: 'manual',
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

describe('Symposium configuration contract', () => {
  it('accepts version 2 with three stable, role-independent seats and a bounded cap', () => {
    const third = {
      ...config.seats[1],
      id: 'implementer',
      role: 'implementer',
      name: 'Implementer',
    };
    const v2 = {
      ...config,
      version: 2,
      activeSeatCap: 3,
      anchorSeatId: 'builder',
      seats: [config.seats[1], third, config.seats[0]],
    };
    expect(SymposiumConfigSchema.parse(v2)).toEqual(v2);
    expect(
      SymposiumConfigSchema.safeParse({
        ...v2,
        seats: [{ ...v2.seats[0], role: 'researcher' }, ...v2.seats.slice(1)],
      }).success,
    ).toBe(true);
    expect(SymposiumConfigSchema.safeParse({ ...v2, activeSeatCap: 0 }).success).toBe(false);
    expect(SymposiumConfigSchema.safeParse({ ...v2, activeSeatCap: 9 }).success).toBe(false);
  });
  it('accepts two independently configured seats', () => {
    expect(SymposiumConfigSchema.parse(config)).toEqual(config);
  });
  it.each([[], [config.seats[0]], [...config.seats, config.seats[0]]].map((seats) => ({ seats })))(
    'requires exactly two seats: $seats.length',
    ({ seats }) => {
      expect(SymposiumConfigSchema.safeParse({ ...config, seats }).success).toBe(false);
    },
  );
  it('rejects duplicate seat identities', () => {
    expect(
      SymposiumConfigSchema.safeParse({ ...config, seats: [config.seats[0], config.seats[0]] })
        .success,
    ).toBe(false);
  });
  it.each([0, -1, 1.5, Infinity])('rejects invalid turn limits: %s', (maxTurns) => {
    expect(
      SymposiumConfigSchema.safeParse({ ...config, turnRules: { mode: 'directed', maxTurns } })
        .success,
    ).toBe(false);
  });
  it('rejects mismatched account/model bindings and embedded credentials', () => {
    for (const change of [{ model: 'other-model' }, { apiKey: 'never-store-this' }]) {
      const seat = config.seats[1];
      expect(
        SymposiumConfigSchema.safeParse({
          ...config,
          seats: [
            config.seats[0],
            { ...seat, accountBinding: { ...seat.accountBinding, ...change } },
          ],
        }).success,
      ).toBe(false);
    }
  });
  it('rejects unsupported provider identities', () => {
    expect(
      AccountBindingSchema.safeParse({
        ...config.seats[0].accountBinding,
        provider: 'personal-provider',
      }).success,
    ).toBe(false);
    expect(
      AccountBindingSchema.safeParse({
        ...config.seats[0].accountBinding,
        provider: 'google-vertex',
      }).success,
    ).toBe(true);
  });
  it('allows incomplete seats only while configuration is a draft', () => {
    const draftSeat = {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer' as const,
      model: 'model-b',
      systemPrompt: 'Review.',
      color: '#008888',
    };
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        state: 'draft',
        seats: [config.seats[0], draftSeat],
      }).success,
    ).toBe(true);
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        seats: [config.seats[0], draftSeat],
      }).success,
    ).toBe(false);
  });
  it('keeps primary and reviewer placement stable', () => {
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        seats: [
          { ...config.seats[0], role: 'reviewer' },
          { ...config.seats[1], role: 'primary' },
        ],
      }).success,
    ).toBe(false);
  });
  it('requires a budget only for the budgeted turn strategy', () => {
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        turnRules: { mode: 'budgeted', maxTurns: 6 },
      }).success,
    ).toBe(false);
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        turnRules: { mode: 'directed', maxTurns: 6, budgetUsd: 1 },
      }).success,
    ).toBe(false);
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        turnRules: { mode: 'budgeted', maxTurns: 6, budgetUsd: 1 },
      }).success,
    ).toBe(true);
  });
  it('allows different account providers inside one Symposium trust domain', () => {
    expect(config.seats[0].accountBinding?.provider).not.toBe(
      config.seats[1].accountBinding?.provider,
    );
    expect(SymposiumConfigSchema.safeParse(config).success).toBe(true);
  });
  it('requires active seats to declare the same Symposium trust domain', () => {
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        seats: [
          config.seats[0],
          {
            ...config.seats[1],
            isolationRequest: {
              trustDomainId: 'other-boundary',
              revision: 1,
              placement: 'dedicated',
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('requires active seats to use the same Symposium trust-domain revision', () => {
    expect(
      SymposiumConfigSchema.safeParse({
        ...config,
        seats: [
          config.seats[0],
          {
            ...config.seats[1],
            isolationRequest: {
              ...config.seats[1].isolationRequest!,
              revision: 2,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('validates the immutable delivery provenance envelope', () => {
    expect(
      SymposiumProvenanceSchema.parse({
        seatId: 'reviewer',
        configRevision: 2,
        accountProfileRevision: 'account-2',
        seatProfileRevision: 'profile-2',
        contextGrantRevision: 3,
        authorityGrantRevision: 4,
        isolationDomainId: 'sandbox-work-1',
        isolationDomainRevision: 5,
      }),
    ).toMatchObject({ seatId: 'reviewer', configRevision: 2 });
  });
});

describe('Symposium persistence', () => {
  it('reserves active capacity atomically and retains suspended seat history', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    const third = { ...config.seats[1], id: 'implementer', role: 'implementer' as const };
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
      seats: [config.seats[0], config.seats[1], third],
    });
    const transition = (
      seatId: string,
      action: 'admit' | 'suspend' | 'restore',
      expectedGeneration: number,
    ) =>
      store.transitionSymposiumMembership({
        sessionId: 'chat',
        seatId,
        action,
        expectedGeneration,
        configRevision: 1,
        actor: 'director',
        reason: action,
        idempotencyKey: `${seatId}:${action}:${expectedGeneration}`,
        occurredAt: Date.now(),
      });
    expect(transition('builder', 'admit', 0)).toMatchObject({ generation: 1, state: 'active' });
    store.markSymposiumMembershipReconciled('chat', 'builder', 1, 'confirmed');
    expect(transition('reviewer', 'admit', 0)).toMatchObject({ generation: 1, state: 'active' });
    store.markSymposiumMembershipReconciled('chat', 'reviewer', 1, 'confirmed');
    expect(() => transition('implementer', 'admit', 0)).toThrow(/cap/i);
    expect(transition('reviewer', 'suspend', 1)).toMatchObject({
      generation: 2,
      state: 'suspended',
      reconciliation: 'pending',
    });
    expect(() => transition('implementer', 'admit', 0)).toThrow(/reconcil/i);
    store.markSymposiumMembershipReconciled('chat', 'reviewer', 2, 'confirmed');
    expect(transition('implementer', 'admit', 0)).toMatchObject({ state: 'active' });
    store.markSymposiumMembershipReconciled('chat', 'implementer', 1, 'confirmed');
    expect(() => transition('reviewer', 'restore', 2)).toThrow(/cap/i);
    expect(
      store.getSymposiumMembershipHistory('chat', 'reviewer').map((entry) => entry.state),
    ).toEqual(['active', 'suspended']);
  });
  it('requires an explicit v2 upgrade and preserves the anchor and historical seat identities', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', config);
    const v2 = {
      ...config,
      version: 2 as const,
      revision: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 3,
      seats: [...config.seats],
    };
    expect(() => store.setSymposiumConfig('chat', { ...v2, anchorSeatId: 'reviewer' })).toThrow(
      /anchor|Seat 1/i,
    );
    store.setSymposiumConfig('chat', v2);
    expect(store.getSymposiumMembershipHistory('chat')).toEqual([]);
    expect(() => store.setSymposiumConfig('chat', { ...config, revision: 3 })).toThrow(
      /downgrade/i,
    );
    expect(() =>
      store.setSymposiumConfig('chat', { ...v2, revision: 3, seats: [config.seats[0]] }),
    ).toThrow(/historical/i);
  });
  it('keeps an immutable transition under later retries and requires explicit recovery confirmation', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    const base = {
      sessionId: 'chat',
      seatId: 'builder',
      action: 'admit' as const,
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'director',
      reason: 'start',
      idempotencyKey: 'first',
      occurredAt: 1,
    };
    const first = store.transitionSymposiumMembership(base);
    expect(first.reconciliation).toBe('pending');
    store.markSymposiumMembershipReconciled('chat', 'builder', 1, 'recovery_required');
    expect(
      store.markSymposiumMembershipReconciled('chat', 'builder', 1, 'confirmed'),
    ).toMatchObject({ reconciliation: 'confirmed' });
    expect(store.transitionSymposiumMembership(base)).toMatchObject({
      generation: 1,
      action: 'admit',
    });
    expect(() => store.transitionSymposiumMembership({ ...base, actor: 'intruder' })).toThrow(
      /idempotency/i,
    );
  });
  it('keeps a provider needed by another admitted seat and retained grants', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    const third = {
      ...config.seats[1],
      id: 'implementer',
      role: 'implementer' as const,
      accountBinding: { ...config.seats[1].accountBinding!, provider: 'openai-codex' as const },
    };
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 3,
      seats: [...config.seats, third],
    });
    for (const seatId of ['builder', 'reviewer', 'implementer']) {
      store.transitionSymposiumMembership({
        sessionId: 'chat',
        seatId,
        action: 'admit',
        expectedGeneration: 0,
        configRevision: 1,
        actor: 'director',
        reason: 'start',
        idempotencyKey: `admit:${seatId}`,
        occurredAt: 1,
      });
      store.markSymposiumMembershipReconciled('chat', seatId, 1, 'confirmed');
      const seat = [...config.seats, third].find((candidate) => candidate.id === seatId)!;
      store.recordSymposiumAdmission({
        admissionId: `admission:${seatId}`,
        sessionId: 'chat',
        seatId,
        membershipGeneration: 1,
        decision: 'admitted',
        reason: null,
        idempotencyKey: `provider:${seatId}`,
        configRevision: 1,
        provider: seat.accountBinding!.provider,
        accountId: seat.accountBinding!.accountId,
        model: seat.model,
        accountProfileRevision: seat.accountBinding!.profileRevision,
        isolationDomainId: seat.isolationRequest!.trustDomainId,
        isolationDomainRevision: seat.isolationRequest!.revision,
        decidedAt: 1,
      });
    }
    store.transitionSymposiumMembership({
      sessionId: 'chat',
      seatId: 'reviewer',
      action: 'suspend',
      expectedGeneration: 1,
      configRevision: 1,
      actor: 'director',
      reason: 'handoff',
      idempotencyKey: 'suspend:reviewer',
      occurredAt: 2,
    });
    expect(store.getSymposiumRequiredProviders('chat', ['anthropic-vertex'])).toEqual([
      'anthropic-vertex',
      'openai-codex',
    ]);
    expect(store.getSymposiumRequiredProviders('chat')).toEqual(['openai-codex']);
  });
  it('does not erase v2 membership history through chat deactivation', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    store.transitionSymposiumMembership({
      sessionId: 'chat',
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'director',
      reason: 'start',
      idempotencyKey: 'membership-builder',
      occurredAt: 1,
    });
    expect(() => store.deactivateSymposium('chat', 1)).toThrow(/membership|v2/i);
    expect(store.getSymposiumMembershipHistory('chat')).toHaveLength(1);
  });
  it('fences v2 event attribution on current membership generation', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    const provenance = {
      seatId: 'reviewer',
      configRevision: 1,
      accountProfileRevision: 'account-2',
      seatProfileRevision: 'profile-2',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'work',
      isolationDomainRevision: 1,
      membershipGeneration: 1,
    };
    expect(() => store.appendSymposium('chat', 'message_start', {}, provenance)).toThrow(
      /membership/i,
    );
    store.transitionSymposiumMembership({
      sessionId: 'chat',
      seatId: 'reviewer',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'director',
      reason: 'start',
      idempotencyKey: 'reviewer-member',
      occurredAt: 1,
    });
    store.markSymposiumMembershipReconciled('chat', 'reviewer', 1, 'confirmed');
    expect(store.appendSymposium('chat', 'message_start', {}, provenance)).toBeGreaterThan(0);
    store.transitionSymposiumMembership({
      sessionId: 'chat',
      seatId: 'reviewer',
      action: 'suspend',
      expectedGeneration: 1,
      configRevision: 1,
      actor: 'director',
      reason: 'pause',
      idempotencyKey: 'reviewer-pause',
      occurredAt: 2,
    });
    expect(() => store.appendSymposium('chat', 'message_start', {}, provenance)).toThrow(
      /membership/i,
    );
  });
  it('suspends, replaces, and restores without changing historical identities', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    const implementer = { ...config.seats[1], id: 'implementer', role: 'implementer' };
    const replacement = { ...config.seats[1], id: 'replacement', role: 'reviewer' };
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
      seats: [...config.seats, implementer, replacement],
    });
    const move = (
      seatId: string,
      action: 'admit' | 'suspend' | 'restore' | 'remove' | 'replace',
      expectedGeneration: number,
      replacesSeatId?: string,
    ) =>
      store.transitionSymposiumMembership({
        sessionId: 'chat',
        seatId,
        action,
        expectedGeneration,
        configRevision: 1,
        actor: 'director',
        reason: action,
        idempotencyKey: `${seatId}:${action}:${expectedGeneration}`,
        occurredAt: expectedGeneration + 1,
        replacesSeatId,
      });
    move('builder', 'admit', 0);
    store.markSymposiumMembershipReconciled('chat', 'builder', 1, 'confirmed');
    move('reviewer', 'admit', 0);
    store.markSymposiumMembershipReconciled('chat', 'reviewer', 1, 'confirmed');
    move('reviewer', 'suspend', 1);
    store.markSymposiumMembershipReconciled('chat', 'reviewer', 2, 'confirmed');
    move('implementer', 'admit', 0);
    store.markSymposiumMembershipReconciled('chat', 'implementer', 1, 'confirmed');
    expect(() => move('reviewer', 'restore', 2)).toThrow(/cap/i);
    move('implementer', 'suspend', 1);
    store.markSymposiumMembershipReconciled('chat', 'implementer', 2, 'confirmed');
    expect(move('reviewer', 'restore', 2)).toMatchObject({ generation: 3, state: 'active' });
    store.markSymposiumMembershipReconciled('chat', 'reviewer', 3, 'confirmed');
    move('reviewer', 'remove', 3);
    store.markSymposiumMembershipReconciled('chat', 'reviewer', 4, 'confirmed');
    expect(() => move('reviewer', 'restore', 4)).toThrow();
    expect(move('replacement', 'replace', 0, 'reviewer')).toMatchObject({
      seatId: 'replacement',
      replacesSeatId: 'reviewer',
      state: 'active',
    });
    expect(store.getLatestSymposiumMembership('chat', 'reviewer')?.replacedBySeatId).toBe(
      'replacement',
    );
    expect(store.getSymposiumMembershipHistory('chat', 'reviewer').map((row) => row.state)).toEqual(
      ['active', 'suspended', 'active', 'removed'],
    );
    expect(store.getLatestSymposiumMembership('chat', 'implementer')?.seatId).toBe('implementer');
  });
  it('reports the exact generation whose reconciliation changed after a later revocation', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', {
      ...config,
      version: 2,
      anchorSeatId: 'builder',
      activeSeatCap: 2,
    });
    const base = {
      sessionId: 'chat',
      seatId: 'reviewer',
      configRevision: 1,
      actor: 'director',
      reason: 'change',
      occurredAt: 1,
    };
    store.transitionSymposiumMembership({
      ...base,
      action: 'admit',
      expectedGeneration: 0,
      idempotencyKey: 'admit',
    });
    store.transitionSymposiumMembership({
      ...base,
      action: 'remove',
      expectedGeneration: 1,
      idempotencyKey: 'remove',
    });
    expect(
      store.markSymposiumMembershipReconciled('chat', 'reviewer', 1, 'recovery_required'),
    ).toMatchObject({ generation: 1, state: 'active', reconciliation: 'recovery_required' });
    expect(store.getLatestSymposiumMembership('chat', 'reviewer')).toMatchObject({
      generation: 2,
      state: 'removed',
      reconciliation: 'pending',
    });
  });
  it('activates only when Seat 1 retains the existing session binding', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    expect(store.setSymposiumConfig('chat', config)).toEqual(config);
    expect(store.getSession('chat')).toMatchObject({
      sessionType: 'symposium',
      accountBinding: config.seats[0].accountBinding,
      symposiumRevision: 1,
    });
    expect(JSON.parse(store.getSession('chat')!.symposiumConfig!)).toEqual(config);
    store.deactivateSymposium('chat', 1);
    expect(store.getSession('chat')).toMatchObject({
      sessionType: 'chat',
      symposiumConfig: null,
      symposiumRevision: 1,
    });
  });
  it('rejects an active configuration bound to a different Seat 1 account', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[1].accountBinding });
    expect(() => store.setSymposiumConfig('chat', config)).toThrow(
      'Seat 1 must retain the existing session account binding',
    );
  });
  it('requires configuration revisions to increase', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', config);
    expect(() => store.setSymposiumConfig('chat', config)).toThrow(
      'Symposium configuration revision must increase',
    );
    expect(store.setSymposiumConfig('chat', { ...config, revision: 2 })).toMatchObject({
      revision: 2,
    });
    store.deactivateSymposium('chat', 2);
    expect(() => store.setSymposiumConfig('chat', config)).toThrow(
      'Symposium configuration revision must increase',
    );
    expect(store.setSymposiumConfig('chat', { ...config, revision: 3 })).toMatchObject({
      revision: 3,
    });
  });
  it('atomically rejects a stale revision from another store instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symposium-cas-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const first = open(path);
    const second = open(path);
    first.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    first.setSymposiumConfig('chat', { ...config, revision: 2 });
    expect(() => second.setSymposiumConfig('chat', config)).toThrow(
      'Symposium configuration revision must increase',
    );
    expect(second.getSession('chat')).toMatchObject({ symposiumRevision: 2 });
  });
  it('atomically rejects stale deactivation from another store instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symposium-deactivate-cas-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const first = open(path);
    const second = open(path);
    first.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    first.setSymposiumConfig('chat', config);
    first.setSymposiumConfig('chat', { ...config, revision: 2 });
    expect(() => second.deactivateSymposium('chat', 1)).toThrow(
      'Symposium deactivation revision conflict',
    );
    expect(second.getSession('chat')).toMatchObject({
      sessionType: 'symposium',
      symposiumRevision: 2,
    });
  });
  it('adds and removes Symposium on the same session without losing history or account binding', () => {
    const store = open();
    store.upsertSession({
      sessionId: 'chat',
      summary: 'Existing work',
      accountBinding: config.seats[0].accountBinding,
    });
    const seq = store.append('chat', 'user_message', { text: 'Original objective' });
    expect(store.getSession('chat')).toMatchObject({ sessionType: 'chat', symposiumConfig: null });
    store.setSymposiumConfig('chat', config);
    store.upsertSession({ sessionId: 'chat', summary: 'Updated title' });
    expect(store.getSession('chat')).toMatchObject({
      sessionType: 'symposium',
      accountBinding: config.seats[0].accountBinding,
    });
    expect(JSON.parse(store.getSession('chat')!.symposiumConfig!)).toEqual(config);
    store.deactivateSymposium('chat', 1);
    expect(store.getSession('chat')).toMatchObject({ sessionType: 'chat', symposiumConfig: null });
    expect(store.getSessionEvents('chat')).toMatchObject([
      { seq, payload: { text: 'Original objective' } },
    ]);
  });
  it('persists seat attribution across reopen and both replay paths, leaving ordinary events unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symposium-'));
    dirs.push(dir);
    const path = join(dir, 'events.db');
    const store = open(path);
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', config);
    const provenance = {
      seatId: 'reviewer',
      configRevision: 1,
      accountProfileRevision: 'account-2',
      seatProfileRevision: 'profile-2',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'work',
      isolationDomainRevision: 1,
    };
    const first = store.appendSymposium('chat', 'message_start', { messageId: 'm1' }, provenance);
    store.append('chat', 'user_message', { text: 'Next' });
    stores.pop()!.close();
    const reopened = open(path);
    expect(JSON.parse(reopened.getSession('chat')!.symposiumConfig!)).toEqual(config);
    expect(reopened.getSessionEvents('chat')[0]).toMatchObject({
      seatId: 'reviewer',
      symposiumProvenance: provenance,
      payload: { messageId: 'm1' },
    });
    expect(reopened.getEventsAfter('chat', 0, 1)[0]).toMatchObject({
      seq: first,
      seatId: 'reviewer',
    });
    expect(reopened.getEventsAfter('chat', first)[0]).not.toHaveProperty('seatId');
  });
  it('rejects stale or unknown seat provenance and never infers it from ordinary payloads', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    const ordinary = store.append('chat', 'message_start', { seatId: 'reviewer' });
    expect(store.getEventsAfter('chat', ordinary - 1)[0]).not.toHaveProperty('seatId');
    store.setSymposiumConfig('chat', config);
    const provenance = {
      seatId: 'reviewer',
      configRevision: 1,
      accountProfileRevision: 'account-2',
      seatProfileRevision: 'profile-2',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'work',
      isolationDomainRevision: 1,
    };
    expect(() =>
      store.appendSymposium('chat', 'message_start', {}, { ...provenance, seatId: 'ghost' }),
    ).toThrow('Symposium provenance references an unknown seat');
    expect(() =>
      store.appendSymposium('chat', 'message_start', {}, { ...provenance, configRevision: 2 }),
    ).toThrow('Symposium provenance does not match the active seat configuration');
  });
  it('rejects seat-attributed events while the Symposium configuration is a draft', () => {
    const store = open();
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', { ...config, state: 'draft' });
    expect(() =>
      store.appendSymposium(
        'chat',
        'message_start',
        {},
        {
          seatId: 'reviewer',
          configRevision: 1,
          accountProfileRevision: 'account-2',
          seatProfileRevision: 'profile-2',
          contextGrantRevision: 1,
          authorityGrantRevision: 1,
          isolationDomainId: 'work',
          isolationDomainRevision: 1,
        },
      ),
    ).toThrow('Cannot append a Symposium event from a draft configuration');
  });
  it('upgrades an existing database idempotently without changing legacy rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symposium-'));
    dirs.push(dir);
    const path = join(dir, 'legacy.db');
    const db = new Database(path);
    db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, summary TEXT, branch TEXT, cwd TEXT, mode TEXT NOT NULL DEFAULT 'agent', is_active INTEGER NOT NULL DEFAULT 1, is_hidden INTEGER NOT NULL DEFAULT 0, prompt_count INTEGER NOT NULL DEFAULT 0, manually_renamed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 1);
      INSERT INTO sessions (session_id, summary) VALUES ('legacy', 'Keep me');
      INSERT INTO events (session_id, type, payload) VALUES ('legacy', 'user_message', '{"text":"Keep history"}');`);
    db.close();
    open(path);
    stores.pop()!.close();
    const reopened = open(path);
    expect(reopened.getSession('legacy')).toMatchObject({
      summary: 'Keep me',
      sessionType: 'chat',
      symposiumConfig: null,
    });
    expect(reopened.getSessionEvents('legacy')[0]).toMatchObject({
      seq: 1,
      payload: { text: 'Keep history' },
    });
    const inspect = new Database(path, { readonly: true });
    try {
      expect(inspect.prepare("PRAGMA table_info('events')").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'seat_id' }),
          expect.objectContaining({ name: 'symposium_provenance' }),
        ]),
      );
      expect(inspect.prepare("PRAGMA table_info('sessions')").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'symposium_revision' })]),
      );
    } finally {
      inspect.close();
    }
  });
});
