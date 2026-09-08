import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import { SymposiumConfigSchema, type SymposiumConfig } from '../src/index.js';

const config: SymposiumConfig = {
  seats: [
    { id: 'builder', name: 'Builder', model: 'model-a', systemPrompt: 'Build.', color: '#8040cc' },
    {
      id: 'reviewer',
      name: 'Reviewer',
      model: 'model-b',
      systemPrompt: 'Review.',
      color: '#008888',
      accountBinding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'vertex',
        model: 'model-b',
        profileRevision: '1',
      },
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
});

describe('Symposium persistence', () => {
  it('adds and removes Symposium on the same session without losing history or account binding', () => {
    const store = open();
    store.upsertSession({
      sessionId: 'chat',
      summary: 'Existing work',
      accountBinding: config.seats[1].accountBinding,
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
      accountBinding: config.seats[1].accountBinding,
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
    } finally {
      inspect.close();
    }
  });
});
