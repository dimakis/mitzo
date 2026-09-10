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
      isolationRequest: { trustDomainId: 'work', placement: 'reuse-compatible' },
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
      isolationRequest: { trustDomainId: 'work', placement: 'reuse-compatible' },
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
            isolationRequest: { trustDomainId: 'other-boundary', placement: 'dedicated' },
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
      }),
    ).toMatchObject({ seatId: 'reviewer', configRevision: 2 });
  });
});

describe('Symposium persistence', () => {
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
    store.deactivateSymposium('chat');
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
    store.deactivateSymposium('chat');
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
  it('adds and removes Symposium on the same session without losing history or account binding', () => {
    const store = open();
    store.upsertSession({
      sessionId: 'chat',
      summary: 'Existing work',
      accountBinding: config.seats[0].accountBinding,
    });
    const seq = store.append('chat', 'user_message', { text: 'Original objective' });
    expect(store.getSession('chat')).toMatchObject({ sessionType: 'chat', symposiumConfig: null });
    store.upsertSession({
      sessionId: 'chat',
      sessionType: 'symposium',
      symposiumConfig: JSON.stringify(config),
    });
    store.upsertSession({ sessionId: 'chat', summary: 'Updated title' });
    expect(store.getSession('chat')).toMatchObject({
      sessionType: 'symposium',
      symposiumConfig: JSON.stringify(config),
      accountBinding: config.seats[0].accountBinding,
    });
    store.upsertSession({ sessionId: 'chat', sessionType: 'chat', symposiumConfig: null });
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
    store.upsertSession({
      sessionId: 'chat',
      sessionType: 'symposium',
      symposiumConfig: JSON.stringify(config),
    });
    const first = store.append('chat', 'message_start', { messageId: 'm1', seatId: 'reviewer' });
    store.append('chat', 'user_message', { text: 'Next' });
    stores.pop()!.close();
    const reopened = open(path);
    expect(reopened.getSession('chat')).toMatchObject({ symposiumConfig: JSON.stringify(config) });
    expect(reopened.getSessionEvents('chat')[0]).toMatchObject({
      seatId: 'reviewer',
      payload: { seatId: 'reviewer' },
    });
    expect(reopened.getEventsAfter('chat', 0, 1)[0]).toMatchObject({
      seq: first,
      seatId: 'reviewer',
    });
    expect(reopened.getEventsAfter('chat', first)[0]).not.toHaveProperty('seatId');
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
        expect.arrayContaining([expect.objectContaining({ name: 'seat_id' })]),
      );
      expect(inspect.prepare("PRAGMA table_info('sessions')").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'symposium_revision' })]),
      );
    } finally {
      inspect.close();
    }
  });
});
